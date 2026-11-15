'use strict';
/*
 * Deployment Approval Escalation server: webhook receiver + live
 * pending-deployment tracker.
 *
 * Event flow:
 *  - workflow_run: a run that is not completed may be waiting on
 *    environment approvals -> reconcile that run against the
 *    pending_deployments endpoint immediately. A completed run
 *    closes out any rows still tracked for it.
 *  - workflow_job: a job in "waiting" status is the deployment job
 *    itself parked on an approval -> reconcile its run. Other job
 *    transitions also reconcile (cheap, and catches the resolution
 *    the moment the job leaves waiting).
 *  - installation: bookkeeping.
 *
 * Timers (remind / escalate / auto-reject) live in the sweep
 * (src/sweep.js); this server keeps the tracked state fresh.
 */
const http = require('http');
const { verifyWebhookSignature } = require('./github');
const { reconcileRun } = require('./reconciler');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createServer({ store, github, webhookSecret, log }) {
  const logger = log || (() => {});

  async function reconcileFromRun(repoRecord, runLike, payloadAction) {
    if (!runLike || runLike.id === undefined) return;
    if (runLike.status === 'completed') {
      store.closePendingForRun(repoRecord.id, runLike.id, `run_${runLike.conclusion || 'completed'}`, Date.now());
      logger(`run completed: ${repoRecord.fullName} run ${runLike.id} (${runLike.conclusion || 'completed'})`);
      return;
    }
    if (typeof github.getPendingDeployments !== 'function') return;
    const run = {
      id: runLike.id,
      name: runLike.name || null,
      html_url: runLike.html_url || null,
      head_branch: runLike.head_branch || null,
      head_sha: runLike.head_sha || null,
      created_at: runLike.created_at || null,
      updated_at: runLike.updated_at || null,
      status: runLike.status || null,
    };
    const { rows } = await reconcileRun({ github, store, repo: repoRecord, run, nowMs: Date.now() });
    if (rows.length) logger(`waiting: ${repoRecord.fullName} run ${run.id} — ${rows.length} pending deployment(s)`);
    void payloadAction;
  }

  async function handleWorkflowRun(payload) {
    const repo = payload.repository;
    const installationId = payload.installation && payload.installation.id;
    if (!repo || !installationId || !payload.workflow_run) return;
    store.recordRepo(repo, installationId);
    const repoRecord = store.getRepo(repo.id);
    await reconcileFromRun(repoRecord, payload.workflow_run, payload.action);
  }

  async function handleWorkflowJob(payload) {
    const repo = payload.repository;
    const installationId = payload.installation && payload.installation.id;
    const job = payload.workflow_job;
    if (!repo || !installationId || !job || job.run_id === undefined) return;
    store.recordRepo(repo, installationId);
    const repoRecord = store.getRepo(repo.id);
    // The job payload has no run status; treat a completed job as a
    // signal to reconcile (the run may still hold other pending
    // deployments), never as proof the run finished.
    const runLike = {
      id: job.run_id,
      name: job.workflow_name || null,
      html_url: job.html_url || null,
      head_branch: job.head_branch || null,
      head_sha: job.head_sha || null,
      created_at: job.created_at || job.started_at || null,
      updated_at: job.completed_at || job.started_at || null,
      status: job.status === 'completed' ? null : job.status,
    };
    await reconcileFromRun(repoRecord, runLike, payload.action);
  }

  async function route(event, payload) {
    if (event === 'installation') {
      if (payload.action === 'created') store.recordInstallation(payload.installation);
      if (payload.action === 'deleted' || payload.action === 'suspend') store.suspendInstallation(payload.installation.id);
      return;
    }
    if (event === 'workflow_run') await handleWorkflowRun(payload);
    else if (event === 'workflow_job') await handleWorkflowJob(payload);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'approval-escalation' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhooks') {
      res.writeHead(404); res.end('not found'); return;
    }
    const raw = await readBody(req);
    if (!verifyWebhookSignature(raw, req.headers['x-hub-signature-256'], webhookSecret)) {
      res.writeHead(401); res.end('bad signature'); return;
    }
    // Acknowledge fast; process async so slow API calls don't make
    // GitHub mark the delivery failed.
    res.writeHead(202); res.end('accepted');
    try {
      const payload = JSON.parse(raw.toString('utf8'));
      await route(req.headers['x-github-event'], payload);
    } catch (err) {
      logger(`handler error: ${err.message}`);
    }
  });
  return server;
}

function main() {
  const fs = require('fs');
  const { Store } = require('./store');
  const { makeGithubClient } = require('./github');
  const { envConfig } = require('./sweep');
  const cfg = envConfig();
  const port = parseInt(process.env.PORT || '8933', 10);
  const webhookSecret = process.env.WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET;
  if (!cfg.appId || !cfg.privateKey || !webhookSecret) {
    console.error('Missing APP_ID / PRIVATE_KEY_PATH / WEBHOOK_SECRET');
    process.exit(2);
  }
  const store = new Store(cfg.storePath);
  const github = makeGithubClient({ appId: cfg.appId, privateKeyPem: cfg.privateKey });
  const server = createServer({ store, github, webhookSecret, log: (m) => console.log(new Date().toISOString(), m) });
  server.listen(port, () => console.log(`Deployment Approval Escalation listening on :${port}`));
}

if (require.main === module) main();

module.exports = { createServer };
