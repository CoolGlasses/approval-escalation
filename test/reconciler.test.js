'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { reconcileRun, reconcileRepo } = require('../src/reconciler');

const NOW = Date.parse('2026-11-13T12:00:00Z');
const REPO = { id: 42, owner: 'acme', name: 'widgets', fullName: 'acme/widgets', installationId: 555, digestEnabled: true };
const RUN = { id: 9001, name: 'Deploy', html_url: 'https://example.test/runs/9001', head_branch: 'main', head_sha: 'abc', created_at: '2026-11-13T07:00:00Z', status: 'waiting' };
const PENDING_FIXTURE = [{
  environment: { id: 7, name: 'production' },
  wait_timer_started_at: '2026-11-13T07:00:00Z',
  reviewers: [
    { type: 'User', reviewer: { id: 1, login: 'alice' } },
    { type: 'Team', reviewer: { id: 2, slug: 'release-leads' } },
  ],
}];

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-recon-'));
  return new Store(path.join(dir, 'store.json'));
}

test('reconcileRun: upserts pending rows from the fixture payload', async () => {
  const store = tmpStore();
  const github = { async getPendingDeployments() { return PENDING_FIXTURE; } };
  const { rows, closed } = await reconcileRun({ github, store, repo: REPO, run: RUN, nowMs: NOW });
  assert.equal(rows.length, 1);
  assert.equal(closed.length, 0);
  const stored = store.getPending('42:9001:7');
  assert.equal(stored.state, 'waiting');
  assert.deepEqual(stored.reviewerUsers, ['alice']);
  assert.equal(stored.waitingSince, '2026-11-13T07:00:00Z');
});

test('reconcileRun: a deployment GitHub stops reporting is closed as left_waiting', async () => {
  const store = tmpStore();
  let fixture = PENDING_FIXTURE;
  const github = { async getPendingDeployments() { return fixture; } };
  await reconcileRun({ github, store, repo: REPO, run: RUN, nowMs: NOW });
  fixture = []; // approved (or rejected) since the last check
  const { rows, closed } = await reconcileRun({ github, store, repo: REPO, run: RUN, nowMs: NOW + 60_000 });
  assert.equal(rows.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].outcome, 'left_waiting');
  assert.equal(store.listOutcomesForRepo(42).length, 1);
});

test('reconcileRepo: completed runs close their rows without an API call for pending', async () => {
  const store = tmpStore();
  const github = {
    async listWorkflowRuns() { return [{ ...RUN, status: 'completed', conclusion: 'success' }]; },
    async getPendingDeployments() { throw new Error('must not be called for completed runs'); },
  };
  store.upsertPending({
    key: '42:9001:7', repoId: 42, runId: 9001, environmentId: 7, environmentName: 'production',
    waitingSince: '2026-11-13T07:00:00Z', state: 'waiting',
  }, NOW);
  await reconcileRepo({ github, store, repo: REPO, nowMs: NOW });
  assert.equal(store.getPending('42:9001:7').outcome, 'run_success');
});
