'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
  return new Store(path.join(dir, 'store.json'));
}

function pendingRow(overrides) {
  return {
    key: '42:9001:7',
    installationId: 555,
    repoId: 42,
    repoFullName: 'acme/widgets',
    owner: 'acme',
    repoName: 'widgets',
    runId: 9001,
    environmentId: 7,
    environmentName: 'production',
    reviewers: [],
    reviewerUsers: ['alice'],
    reviewerTeams: [],
    waitingSince: '2026-11-13T07:00:00Z',
    state: 'waiting',
    ...overrides,
  };
}

test('store: two processes sharing one file lose no writes (SameTree 7d982cc regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-store-'));
  const file = path.join(dir, 'store.json');
  const serverSide = new Store(file); // constructed first, holds stale memory
  const sweepSide = new Store(file);
  // Sweep writes first, from its own copy...
  sweepSide.upsertPending(pendingRow());
  // ...then the server records an installation from its stale copy.
  serverSide.recordInstallation({ id: 555, account: { login: 'acme' } });
  // A fresh reader must see BOTH writes.
  const fresh = new Store(file);
  assert.ok(fresh.getPending('42:9001:7'));
  assert.equal(fresh.data.installations[555].accountLogin, 'acme');
  // And in the other order.
  serverSide.setTrackingIssue(42, 11);
  sweepSide.closePending('42:9001:7', 'run_success');
  const fresh2 = new Store(file);
  assert.equal(fresh2.getTrackingIssue(42), 11);
  assert.equal(fresh2.getPending('42:9001:7').state, 'closed');
  assert.equal(fresh2.listOutcomesForRepo(42).length, 1);
});

test('store: reconciler refresh never un-fires a tier flag', () => {
  const store = tmpStore();
  store.upsertPending(pendingRow());
  store.updatePending('42:9001:7', { reminded: true, remindedAt: '2026-11-13T11:00:00Z' });
  // A fresh parse of the same pending deployment refreshes lastSeenAt
  // but must keep reminded: true.
  const refreshed = store.upsertPending(pendingRow());
  assert.equal(refreshed.reminded, true);
  assert.equal(refreshed.remindedAt, '2026-11-13T11:00:00Z');
});

test('store: closePendingForRun closes only the given run, sparing confirmed keys', () => {
  const store = tmpStore();
  store.upsertPending(pendingRow());
  store.upsertPending(pendingRow({ key: '42:9002:7', runId: 9002 }));
  const closed = store.closePendingForRun(42, 9001, 'run_failure', Date.parse('2026-11-13T12:00:00Z'), new Set());
  assert.equal(closed.length, 1);
  assert.equal(closed[0].outcome, 'run_failure');
  assert.equal(store.getPending('42:9002:7').state, 'waiting');
  const spared = store.closePendingForRun(42, 9002, 'run_failure', Date.parse('2026-11-13T12:00:00Z'), new Set(['42:9002:7']));
  assert.equal(spared.length, 0);
});
