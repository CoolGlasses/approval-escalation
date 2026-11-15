'use strict';
/*
 * Scheduled jobs for Deployment Approval Escalation.
 *
 *   node src/sweep.js          — the timer wheel: reconcile every
 *     installed repo against the API (catch missed webhooks, close
 *     resolved rows), then evaluate every waiting row against its
 *     repo's policy and execute remind / escalate / auto-reject.
 *   node src/sweep.js digest   — one digest issue per repo per ISO
 *     week: created on first run of the week, updated (not
 *     duplicated) on later runs, Janitor-style.
 *
 * Cron shape (deployment, not in this repo's control):
 *   every 15 min  sweep.js          (the reminder cadence)
 *   Mon 07:30     sweep.js digest   (per-repo digest_weekday can
 *                                    move the day)
 */
const logic = require('./logic');
const { reconcileAll } = require('./reconciler');
const { loadPolicy, applyDecision } = require('./actions');

async function evaluateRepo({ github, store, repo, nowMs, log }) {
  const logger = log || (() => {});
  const now = nowMs || Date.now();
  const policy = await loadPolicy({ github, repo, nowMs: now });
  let acted = 0;
  for (const row of store.listWaitingForRepo(repo.id)) {
    const decisions = logic.evaluatePending(row, policy, now);
    for (const decision of decisions) {
      if (await applyDecision({ github, store, repo, row, decision, policy, nowMs: now, log: logger })) acted++;
    }
  }
  return acted;
}

async function runSweep({ github, store, nowMs, log }) {
  const logger = log || (() => {});
  const now = nowMs || Date.now();
  await reconcileAll({ github, store, nowMs: now, log: logger });
  let acted = 0;
  for (const repo of store.listRepos()) {
    acted += await evaluateRepo({ github, store, repo, nowMs: now, log: logger });
  }
  logger(`sweep complete: ${acted} action(s) taken`);
  return acted;
}

async function runDigest({ github, store, nowMs, log }) {
  const logger = log || (() => {});
  const now = nowMs || Date.now();
  const weekKey = logic.isoWeekKey(new Date(now));
  let count = 0;
  for (const repo of store.listRepos()) {
    if (repo.digestEnabled === false) continue;
    // Honour the per-repo digest weekday when a policy exists; the
    // cron line proposes Monday, the config can move it.
    const policy = await loadPolicy({ github, repo, nowMs: now });
    if (new Date(now).getDay() !== policy.digest_weekday) continue;
    const body = logic.buildDigestMarkdown(repo.fullName, {
      pending: store.listWaitingForRepo(repo.id),
      outcomes: store.listOutcomesForRepo(repo.id),
    }, now);
    const title = `📋 Deployment approval digest — ${weekKey}`;
    const existing = store.getDigest(repo.id, weekKey);
    if (existing) {
      await github.updateIssue(repo.installationId, repo.owner, repo.name, existing.issueNumber, body);
      logger(`digest updated: ${repo.fullName} issue #${existing.issueNumber} (${weekKey})`);
    } else {
      const issue = await github.createIssue(repo.installationId, repo.owner, repo.name, title, body);
      store.setDigest(repo.id, weekKey, issue.number);
      logger(`digest created: ${repo.fullName} issue #${issue.number} (${weekKey})`);
    }
    count++;
  }
  return count;
}

function envConfig() {
  const fs = require('fs');
  return {
    appId: process.env.APP_ID || process.env.GITHUB_APP_ID,
    privateKey: process.env.PRIVATE_KEY_PATH
      ? fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8')
      : process.env.GITHUB_APP_PRIVATE_KEY_PATH
        ? fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
        : process.env.PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY,
    storePath: process.env.APPROVAL_ESCALATION_STORE || require('path').join(__dirname, '..', 'data', 'store.json'),
  };
}

function main() {
  const { Store } = require('./store');
  const { makeGithubClient } = require('./github');
  const mode = process.argv[2] || 'sweep';
  const cfg = envConfig();
  if (!cfg.appId || !cfg.privateKey) {
    console.error('Missing APP_ID / PRIVATE_KEY_PATH');
    process.exit(2);
  }
  const store = new Store(cfg.storePath);
  const github = makeGithubClient({ appId: cfg.appId, privateKeyPem: cfg.privateKey });
  const log = (m) => console.log(new Date().toISOString(), m);
  const run = mode === 'digest' ? runDigest({ github, store, log }) : runSweep({ github, store, log });
  run.then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

if (require.main === module) main();

module.exports = { runSweep, runDigest, evaluateRepo, envConfig };
