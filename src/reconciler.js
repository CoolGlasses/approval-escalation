'use strict';
/*
 * The reconciler: ground truth from the API, so the app stays
 * correct even when webhooks are missed (restart windows, failed
 * deliveries). For each run it asks GitHub which deployments are
 * pending RIGHT NOW, upserts rows for those, and closes tracked rows
 * for that run that GitHub no longer reports — a deployment leaves
 * "pending" exactly when it is approved or rejected.
 */
const logic = require('./logic');

async function reconcileRun({ github, store, repo, run, nowMs, outcomeWhenMissing }) {
  const now = nowMs || Date.now();
  const deployments = await github.getPendingDeployments(repo.installationId, repo.owner, repo.name, run.id);
  const rows = logic.parsePendingDeployments({ repo, run, deployments, nowMs: now });
  const currentKeys = new Set();
  for (const row of rows) {
    store.upsertPending(row, now);
    currentKeys.add(row.key);
  }
  const closed = store.closePendingForRun(repo.id, run.id, outcomeWhenMissing || 'left_waiting', now, currentKeys);
  return { rows, closed };
}

async function reconcileRepo({ github, store, repo, nowMs, log }) {
  const logger = log || (() => {});
  const now = nowMs || Date.now();
  let runs;
  try {
    runs = await github.listWorkflowRuns(repo.installationId, repo.owner, repo.name);
  } catch (err) {
    logger(`reconcile failed for ${repo.fullName}: ${err.message}`);
    return 0;
  }
  let seen = 0;
  for (const run of runs) {
    if (run.status === 'completed') {
      // A completed run holds no pending deployments; anything we
      // still track for it resolved (or was rejected) en route.
      store.closePendingForRun(repo.id, run.id, `run_${run.conclusion || 'completed'}`, now);
      continue;
    }
    try {
      const { rows } = await reconcileRun({ github, store, repo, run, nowMs: now });
      seen += rows.length;
    } catch (err) {
      logger(`pending-deployments check failed for ${repo.fullName} run ${run.id}: ${err.message}`);
    }
  }
  return seen;
}

async function reconcileAll({ github, store, nowMs, log }) {
  let total = 0;
  for (const repo of store.listRepos()) {
    total += await reconcileRepo({ github, store, repo, nowMs, log });
  }
  return total;
}

module.exports = { reconcileRun, reconcileRepo, reconcileAll };
