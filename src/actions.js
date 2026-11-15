'use strict';
/*
 * Executes the decisions logic.evaluatePending returns, and loads
 * per-repo policy. All GitHub writes go through here so the sweep
 * behaves identically wherever it is invoked from.
 */
const logic = require('./logic');

// In-process policy cache: repoId -> { policy, fetchedAtMs }. The
// sweep is a fresh process per run, so this only dedupes within a run.
const policyCache = new Map();
const POLICY_TTL_MS = 10 * 60_000;

async function loadPolicy({ github, repo, nowMs }) {
  const now = nowMs || Date.now();
  const cached = policyCache.get(repo.id);
  if (cached && now - cached.fetchedAtMs < POLICY_TTL_MS) return cached.policy;
  let policy = { ...logic.DEFAULT_POLICY };
  try {
    const text = await github.getFileContent(repo.installationId, repo.owner, repo.name, logic.CONFIG_PATH);
    if (text) policy = logic.parsePolicyConfig(text);
  } catch (_) {
    // Config unreadable -> defaults. A broken config must never take
    // the reminder service down with it.
  }
  policyCache.set(repo.id, { policy, fetchedAtMs: now });
  return policy;
}

function clearPolicyCache() { policyCache.clear(); }

/*
 * The one tracking issue per repo ("Deployment approvals waiting").
 * Its body always mirrors the currently-waiting set; reminder and
 * escalation comments land on it. Stored issue number wins; fall back
 * to finding an open issue by title (store rebuilt / issue created by
 * hand); create only when neither exists.
 */
async function ensureTrackingIssue({ github, store, repo, nowMs }) {
  const now = nowMs || Date.now();
  const body = logic.buildTrackingIssueBody(repo.fullName, store.listWaitingForRepo(repo.id), now);
  const stored = store.getTrackingIssue(repo.id);
  if (stored) {
    await github.updateIssue(repo.installationId, repo.owner, repo.name, stored, body);
    return stored;
  }
  if (typeof github.listIssues === 'function') {
    const issues = await github.listIssues(repo.installationId, repo.owner, repo.name, 'open');
    const found = (issues || []).find((i) => i.title === logic.TRACKING_ISSUE_TITLE);
    if (found) {
      store.setTrackingIssue(repo.id, found.number);
      await github.updateIssue(repo.installationId, repo.owner, repo.name, found.number, body);
      return found.number;
    }
  }
  const issue = await github.createIssue(repo.installationId, repo.owner, repo.name, logic.TRACKING_ISSUE_TITLE, body);
  store.setTrackingIssue(repo.id, issue.number);
  return issue.number;
}

async function applyDecision({ github, store, repo, row, decision, policy, nowMs, log }) {
  const logger = log || (() => {});
  const now = nowMs || Date.now();
  const nowIso = new Date(now).toISOString();
  try {
    if (decision.type === 'remind' || decision.type === 'escalate') {
      const issueNumber = await ensureTrackingIssue({ github, store, repo, nowMs: now });
      const body = logic.commentBody(decision.type, row, policy, now);
      await github.createComment(repo.installationId, repo.owner, repo.name, issueNumber, body);
      if (decision.type === 'remind') {
        store.updatePending(row.key, { reminded: true, remindedAt: nowIso });
      } else {
        store.updatePending(row.key, { escalated: true, escalatedAt: nowIso });
      }
      store.appendEvent({ repoId: repo.id, runId: row.runId, action: `${decision.type}:${row.environmentName}` });
      logger(`${decision.type}: ${repo.fullName} run ${row.runId} (${row.environmentName}, ${Math.round(decision.ageHours * 10) / 10}h)`);
      return true;
    }
    if (decision.type === 'auto-reject') {
      if (row.environmentId === null || row.environmentId === undefined) {
        // The review endpoint keys on environment IDs; a name alone
        // cannot be rejected through it. Leave the row waiting and
        // say so — the live smoke test should confirm IDs are always
        // present in real payloads.
        logger(`auto-reject skipped for ${repo.fullName} run ${row.runId}: no environment id`);
        return false;
      }
      await github.reviewPendingDeployments(repo.installationId, repo.owner, repo.name, row.runId, {
        environmentIds: [row.environmentId],
        state: 'rejected',
        comment: `Auto-rejected by Deployment Approval Escalation after ${logic.formatAge(decision.ageHours)} waiting (repository policy: auto_reject_after_hours).`,
      });
      store.updatePending(row.key, { expired: true, expiredAt: nowIso });
      store.closePending(row.key, 'auto_rejected', now);
      store.appendEvent({ repoId: repo.id, runId: row.runId, action: `auto-reject:${row.environmentName}` });
      logger(`auto-reject: ${repo.fullName} run ${row.runId} (${row.environmentName}, ${Math.round(decision.ageHours * 10) / 10}h)`);
      // Refresh the tracking issue so the waiting list drops the row.
      await ensureTrackingIssue({ github, store, repo, nowMs: now });
      return true;
    }
    logger(`unknown decision type: ${decision.type}`);
    return false;
  } catch (err) {
    logger(`action ${decision.type} failed for ${repo.fullName} run ${row.runId}: ${err.message}`);
    return false;
  }
}

module.exports = { loadPolicy, clearPolicyCache, ensureTrackingIssue, applyDecision };
