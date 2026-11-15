'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');

const SECRET = 'test-secret';
const REPO = { id: 42, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } };
const PENDING_FIXTURE = [{
  environment: { id: 7, name: 'production' },
  wait_timer_started_at: '2026-11-13T07:00:00Z',
  reviewers: [{ type: 'User', reviewer: { id: 1, login: 'alice' } }],
}];

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-server-'));
  const store = new Store(path.join(dir, 'store.json'));
  const github = { async getPendingDeployments() { return PENDING_FIXTURE; } };
  const server = createServer({ store, github, webhookSecret: SECRET, log: () => {} });
  await new Promise((r) => server.listen(0, r));
  return { store, server, port: server.address().port };
}

async function post(port, event, payload, signature) {
  const body = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature || sign(body) },
    body,
  });
  return res.status;
}

test('server: health, signed workflow_run waiting -> row tracked', async () => {
  const { store, server, port } = await startServer();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'approval-escalation');

    const status = await post(port, 'workflow_run', {
      action: 'requested',
      installation: { id: 555 },
      repository: REPO,
      workflow_run: {
        id: 9001, name: 'Deploy', status: 'waiting', conclusion: null,
        html_url: 'https://example.test/runs/9001', head_branch: 'main', head_sha: 'abc',
        created_at: '2026-11-13T07:00:00Z', updated_at: '2026-11-13T07:00:00Z',
      },
    });
    assert.equal(status, 202);
    await waitFor(() => store.getPending('42:9001:7'));
    assert.equal(store.getPending('42:9001:7').environmentName, 'production');
    assert.deepEqual(store.getPending('42:9001:7').reviewerUsers, ['alice']);
  } finally {
    server.close();
  }
});

test('server: workflow_job waiting reconciles its run; completed run closes rows', async () => {
  const { store, server, port } = await startServer();
  try {
    const status = await post(port, 'workflow_job', {
      action: 'waiting',
      installation: { id: 555 },
      repository: REPO,
      workflow_job: {
        id: 31337, run_id: 9001, status: 'waiting', workflow_name: 'Deploy',
        html_url: 'https://example.test/jobs/31337', head_branch: 'main', head_sha: 'abc',
        created_at: '2026-11-13T07:00:00Z', started_at: '2026-11-13T07:00:00Z', completed_at: null,
      },
    });
    assert.equal(status, 202);
    await waitFor(() => store.getPending('42:9001:7'));

    const done = await post(port, 'workflow_run', {
      action: 'completed',
      installation: { id: 555 },
      repository: REPO,
      workflow_run: {
        id: 9001, name: 'Deploy', status: 'completed', conclusion: 'success',
        html_url: 'https://example.test/runs/9001', head_branch: 'main', head_sha: 'abc',
        created_at: '2026-11-13T07:00:00Z', updated_at: '2026-11-13T09:00:00Z',
      },
    });
    assert.equal(done, 202);
    await waitFor(() => store.getPending('42:9001:7').state === 'closed');
    assert.equal(store.getPending('42:9001:7').outcome, 'run_success');
  } finally {
    server.close();
  }
});

test('server: bad signature is rejected 401', async () => {
  const { server, port } = await startServer();
  try {
    const status = await post(port, 'workflow_run', { action: 'requested' }, 'sha256=deadbeef');
    assert.equal(status, 401);
  } finally {
    server.close();
  }
});
