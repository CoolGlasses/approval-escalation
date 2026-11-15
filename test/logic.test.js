'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../src/logic');

const NOW = Date.parse('2026-11-13T12:00:00Z');
const H = 3_600_000;

function row(overrides) {
  return {
    key: '42:9001:7',
    installationId: 555,
    repoId: 42,
    repoFullName: 'acme/widgets',
    owner: 'acme',
    repoName: 'widgets',
    runId: 9001,
    runUrl: 'https://github.com/acme/widgets/actions/runs/9001',
    workflowName: 'Deploy',
    headBranch: 'main',
    headSha: 'abc',
    environmentId: 7,
    environmentName: 'production',
    reviewers: [{ type: 'User', id: 1, login: 'alice' }, { type: 'Team', id: 2, slug: 'release-leads' }],
    reviewerUsers: ['alice'],
    reviewerTeams: ['release-leads'],
    waitingSince: new Date(NOW - 5 * H).toISOString(),
    state: 'waiting',
    reminded: false,
    escalated: false,
    expired: false,
    ...overrides,
  };
}

test('parsePolicyConfig: defaults when absent', () => {
  const p = logic.parsePolicyConfig('');
  assert.equal(p.remind_after_hours, 4);
  assert.equal(p.escalate_after_hours, 24);
  assert.equal(p.auto_reject_after_hours, null);
  assert.deepEqual(p.escalation_mentions, []);
  assert.equal(p.digest_weekday, 1);
});

test('parsePolicyConfig: custom hours, inline + block lists, weekday name', () => {
  const p = logic.parsePolicyConfig([
    'remind_after_hours: 2',
    'escalate_after_hours: 8',
    'auto_reject_after_hours: 48',
    'escalation_mentions: [@acme/release-leads, bob]',
    'digest_weekday: Friday',
  ].join('\n'));
  assert.equal(p.remind_after_hours, 2);
  assert.equal(p.escalate_after_hours, 8);
  assert.equal(p.auto_reject_after_hours, 48);
  assert.deepEqual(p.escalation_mentions, ['acme/release-leads', 'bob']);
  assert.equal(p.digest_weekday, 5);

  const block = logic.parsePolicyConfig('escalation_mentions:\n  - alice\n  - acme/platform\n');
  assert.deepEqual(block.escalation_mentions, ['alice', 'acme/platform']);
});

test('parsePolicyConfig: auto_reject off/null and bad values fall back', () => {
  assert.equal(logic.parsePolicyConfig('auto_reject_after_hours: off\n').auto_reject_after_hours, null);
  assert.equal(logic.parsePolicyConfig('auto_reject_after_hours: null\n').auto_reject_after_hours, null);
  assert.equal(logic.parsePolicyConfig('remind_after_hours: banana\n').remind_after_hours, 4);
  assert.equal(logic.parsePolicyConfig('remind_after_hours: -3\n').remind_after_hours, 4);
});

test('evaluatePending: boundary — just under remind fires nothing, exactly at fires', () => {
  const policy = logic.DEFAULT_POLICY;
  assert.deepEqual(logic.evaluatePending(row({ waitingSince: new Date(NOW - (4 * H - 1000)).toISOString() }), policy, NOW), []);
  const at = logic.evaluatePending(row({ waitingSince: new Date(NOW - 4 * H).toISOString() }), policy, NOW);
  assert.equal(at.length, 1);
  assert.equal(at[0].type, 'remind');
});

test('evaluatePending: reminded row does not re-remind; escalate fires at 24h', () => {
  const policy = logic.DEFAULT_POLICY;
  const reminded = row({ waitingSince: new Date(NOW - 5 * H).toISOString(), reminded: true });
  assert.deepEqual(logic.evaluatePending(reminded, policy, NOW), []);
  const justUnder = row({ waitingSince: new Date(NOW - (24 * H - 1000)).toISOString(), reminded: true });
  assert.deepEqual(logic.evaluatePending(justUnder, policy, NOW), []);
  const at = logic.evaluatePending(row({ waitingSince: new Date(NOW - 24 * H).toISOString(), reminded: true }), policy, NOW);
  assert.equal(at[0].type, 'escalate');
});

test('evaluatePending: escalation subsumes a missed reminder', () => {
  const at = logic.evaluatePending(row({ waitingSince: new Date(NOW - 25 * H).toISOString() }), logic.DEFAULT_POLICY, NOW);
  assert.deepEqual(at.map((a) => a.type), ['escalate']);
});

test('evaluatePending: auto-reject outranks escalation and honours null = off', () => {
  const policy = { ...logic.DEFAULT_POLICY, auto_reject_after_hours: 48 };
  const at = logic.evaluatePending(row({ waitingSince: new Date(NOW - 49 * H).toISOString() }), policy, NOW);
  assert.deepEqual(at.map((a) => a.type), ['auto-reject']);
  const justUnder = logic.evaluatePending(row({ waitingSince: new Date(NOW - (48 * H - 1000)).toISOString() }), policy, NOW);
  assert.equal(justUnder[0].type, 'escalate');
  const off = logic.evaluatePending(row({ waitingSince: new Date(NOW - 200 * H).toISOString(), escalated: true }), logic.DEFAULT_POLICY, NOW);
  assert.deepEqual(off, []);
});

test('evaluatePending: closed rows never fire', () => {
  assert.deepEqual(logic.evaluatePending(row({ state: 'closed', outcome: 'run_success' }), logic.DEFAULT_POLICY, NOW), []);
});

test('parsePendingDeployments: environment, reviewers, waitingSince', () => {
  const repo = { id: 42, owner: 'acme', name: 'widgets', fullName: 'acme/widgets', installationId: 555 };
  const run = { id: 9001, html_url: 'https://example.test/runs/9001', name: 'Deploy', head_branch: 'main', head_sha: 'abc', created_at: new Date(NOW - 5 * H).toISOString() };
  const deployments = [{
    environment: { id: 7, name: 'production' },
    wait_timer_started_at: new Date(NOW - 5 * H).toISOString(),
    reviewers: [
      { type: 'User', reviewer: { id: 1, login: 'alice' } },
      { type: 'User', reviewer: { id: 1, login: 'alice' } }, // duplicate: deduped
      { type: 'Team', reviewer: { id: 2, slug: 'release-leads' } },
    ],
  }];
  const rows = logic.parsePendingDeployments({ repo, run, deployments, nowMs: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, '42:9001:7');
  assert.equal(rows[0].environmentName, 'production');
  assert.deepEqual(rows[0].reviewerUsers, ['alice']);
  assert.deepEqual(rows[0].reviewerTeams, ['release-leads']);
  assert.equal(rows[0].waitingSince, new Date(NOW - 5 * H).toISOString());
  // No environment id: the key falls back to the environment name.
  const nameless = logic.parsePendingDeployments({ repo, run, deployments: [{ environment: { name: 'staging' }, reviewers: [] }], nowMs: NOW });
  assert.equal(nameless[0].key, '42:9001:name:staging');
  assert.equal(nameless[0].environmentId, null);
});

test('commentBody: remind @mentions reviewers, escalate @mentions the fallback list', () => {
  const remind = logic.commentBody('remind', row(), logic.DEFAULT_POLICY, NOW);
  assert.match(remind, /@alice/);
  assert.match(remind, /@acme\/release-leads/);
  assert.match(remind, /production/);
  const esc = logic.commentBody('escalate', row(), { ...logic.DEFAULT_POLICY, escalation_mentions: ['acme/release-leads', 'bob'] }, NOW);
  assert.match(esc, /@acme\/release-leads/);
  assert.match(esc, /@bob/);
});

test('buildDigestMarkdown: median wait and expiry count', () => {
  const outcomes = [2, 4, 10].map((h, i) => ({
    repoId: 42, runId: 100 + i, environmentName: 'production',
    waitingSince: new Date(NOW - h * H).toISOString(),
    closedAt: new Date(NOW).toISOString(), outcome: i === 2 ? 'auto_rejected' : 'run_success',
  }));
  const md = logic.buildDigestMarkdown('acme/widgets', { pending: [], outcomes }, NOW);
  assert.match(md, /Median wait: \*\*4h\*\*/);
  assert.match(md, /Auto-rejected at expiry: \*\*1\*\*/);
  assert.match(md, /Approvals that waited and resolved: \*\*3\*\*/);
});

test('isoWeekKey matches the system ISO calendar', () => {
  assert.equal(logic.isoWeekKey(new Date('2026-11-13T12:00:00Z')), '2026-W46');
  assert.equal(logic.isoWeekKey(new Date('2026-11-16T12:00:00Z')), '2026-W47');
});
