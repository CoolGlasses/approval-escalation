'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { runSweep, runDigest } = require('../src/sweep');
const { clearPolicyCache } = require('../src/actions');

const NOW = Date.parse('2026-11-13T12:00:00Z'); // a Friday
const MONDAY = Date.parse('2026-11-16T12:00:00Z');
const H = 3_600_000;
const REPO_API = { id: 42, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-sweep-'));
  return new Store(path.join(dir, 'store.json'));
}

function seedRepo(store) {
  store.recordInstallation({ id: 555, account: { login: 'acme' } });
  store.recordRepo(REPO_API, 555);
  return store.getRepo(42);
}

function seedRow(store, ageHours, overrides) {
  store.upsertPending({
    key: '42:9001:7',
    installationId: 555,
    repoId: 42,
    repoFullName: 'acme/widgets',
    owner: 'acme',
    repoName: 'widgets',
    runId: 9001,
    runUrl: 'https://example.test/runs/9001',
    workflowName: 'Deploy',
    environmentId: 7,
    environmentName: 'production',
    reviewers: [{ type: 'User', id: 1, login: 'alice' }],
    reviewerUsers: ['alice'],
    reviewerTeams: [],
    waitingSince: new Date(NOW - ageHours * H).toISOString(),
    state: 'waiting',
    ...overrides,
  }, NOW);
}

function makeMockGithub({ configText } = {}) {
  const calls = [];
  return {
    calls,
    find: (m) => calls.filter((c) => c.method === m),
    async listWorkflowRuns() { return []; }, // nothing new; seeded rows stand
    async getPendingDeployments() { return []; },
    async getFileContent(inst, owner, repo, p) { return p === '.github/approval-escalation.yml' ? (configText || null) : null; },
    async listIssues() { return []; },
    async createIssue(inst, owner, repo, title, body) { calls.push({ method: 'createIssue', title, body }); return { number: 11 }; },
    async updateIssue(inst, owner, repo, number, body) { calls.push({ method: 'updateIssue', number, body }); return {}; },
    async createComment(inst, owner, repo, number, body) { calls.push({ method: 'createComment', number, body }); return { id: 1 }; },
    async reviewPendingDeployments(inst, owner, repo, runId, opts) { calls.push({ method: 'reviewPendingDeployments', runId, opts }); return []; },
  };
}

test('sweep: 5h-old row gets a reminder comment on the tracking issue, once', async () => {
  clearPolicyCache();
  const store = tmpStore();
  seedRepo(store);
  seedRow(store, 5);
  const github = makeMockGithub();
  const acted = await runSweep({ github, store, nowMs: NOW, log: () => {} });
  assert.equal(acted, 1);
  const comments = github.find('createComment');
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /@alice/);
  assert.equal(comments[0].number, 11); // the tracking issue it created
  assert.equal(store.getPending('42:9001:7').reminded, true);
  // Second sweep at the same clock: throttle holds, no re-comment.
  const acted2 = await runSweep({ github, store, nowMs: NOW, log: () => {} });
  assert.equal(acted2, 0);
  assert.equal(github.find('createComment').length, 1);
});

test('sweep: 25h-old reminded row escalates to the configured mentions', async () => {
  clearPolicyCache();
  const store = tmpStore();
  seedRepo(store);
  seedRow(store, 25, { reminded: true, remindedAt: new Date(NOW - 21 * H).toISOString() });
  const github = makeMockGithub({ configText: 'escalation_mentions:\n  - acme/release-leads\n' });
  const acted = await runSweep({ github, store, nowMs: NOW, log: () => {} });
  assert.equal(acted, 1);
  const comments = github.find('createComment');
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /escalation/i);
  assert.match(comments[0].body, /@acme\/release-leads/);
  assert.equal(store.getPending('42:9001:7').escalated, true);
});

test('sweep: auto-reject fires only when configured, and closes the row', async () => {
  clearPolicyCache();
  const store = tmpStore();
  seedRepo(store);
  seedRow(store, 49, { reminded: true, escalated: true });
  const github = makeMockGithub({ configText: 'auto_reject_after_hours: 48\n' });
  const acted = await runSweep({ github, store, nowMs: NOW, log: () => {} });
  assert.equal(acted, 1);
  const reviews = github.find('reviewPendingDeployments');
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0].opts.environmentIds, [7]);
  assert.equal(reviews[0].opts.state, 'rejected');
  const row = store.getPending('42:9001:7');
  assert.equal(row.state, 'closed');
  assert.equal(row.outcome, 'auto_rejected');
  assert.equal(row.expired, true);
});

test('digest: created once per ISO week, then updated in place; weekday honoured', async () => {
  clearPolicyCache();
  const store = tmpStore();
  seedRepo(store);
  seedRow(store, 30);
  const github = makeMockGithub();
  // Friday run: default digest_weekday is Monday -> nothing.
  assert.equal(await runDigest({ github, store, nowMs: NOW, log: () => {} }), 0);
  // Monday: created...
  assert.equal(await runDigest({ github, store, nowMs: MONDAY, log: () => {} }), 1);
  assert.equal(github.find('createIssue').length, 1); // tracking issue is not created by digest path; this is the digest
  const digestCreates = github.find('createIssue').filter((c) => /digest/i.test(c.title));
  assert.equal(digestCreates.length, 1);
  // ...and a second Monday run updates the same issue.
  assert.equal(await runDigest({ github, store, nowMs: MONDAY + H, log: () => {} }), 1);
  assert.equal(github.find('updateIssue').filter((c) => c.number === 11).length >= 1, true);
});
