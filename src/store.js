'use strict';
/*
 * Tiny JSON-file store, same discipline as SameTree's (the pattern
 * from its commit 7d982cc): the webhook server and the cron-run sweep
 * share this file and each holds data in memory, so every mutation
 * runs inside a lockfile-held transaction that RELOADS from disk
 * first, applies the change, then writes back atomically (tmp file +
 * rename). Reads reload first; the atomic rename means a reader never
 * sees a partial file.
 */
const fs = require('fs');
const path = require('path');

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.data = Store.emptyData();
    this.load();
  }

  static emptyData() {
    return {
      installations: {}, // id -> { id, accountLogin, suspended, seenAt }
      repos: {},         // repoId -> { id, owner, name, fullName, installationId, digestEnabled }
      pending: {},       // key -> tracked pending-deployment row (see logic.js header)
      outcomes: [],      // closed rows, appended on close-out (digest input)
      trackingIssues: {},// repoId -> issue number of "Deployment approvals waiting"
      digests: {},       // `${repoId}:${isoWeek}` -> { issueNumber, updatedAt }
      events: [],        // append-only action log { at, repoId, runId, action }
    };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...Store.emptyData(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = Store.emptyData();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.filePath);
  }

  acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        return fs.openSync(this.lockPath, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const st = fs.statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(this.lockPath); continue; }
        } catch (_) { continue; }
        if (Date.now() > deadline) throw new Error(`store lock timeout: ${this.lockPath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }

  transact(mutate) {
    const fd = this.acquireLock();
    try {
      this.load();
      const result = mutate(this.data);
      this.save();
      return result;
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(this.lockPath); } catch (_) {}
    }
  }

  recordInstallation(inst) {
    this.transact((data) => {
      data.installations[inst.id] = {
        id: inst.id,
        accountLogin: inst.account && inst.account.login,
        suspended: false,
        seenAt: new Date().toISOString(),
      };
    });
  }

  suspendInstallation(id) {
    this.transact((data) => {
      if (data.installations[id]) data.installations[id].suspended = true;
    });
  }

  recordRepo(repo, installationId) {
    this.transact((data) => {
      const existing = data.repos[repo.id];
      data.repos[repo.id] = {
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        installationId,
        digestEnabled: existing ? existing.digestEnabled !== false : true,
      };
    });
  }

  getRepo(repoId) {
    this.load();
    return this.data.repos[repoId] || null;
  }

  listRepos() {
    this.load();
    return Object.values(this.data.repos);
  }

  /*
   * Insert or refresh a pending row. Fields in `record` win except
   * that null/undefined never erases a known value, and the tier
   * flags/timestamps (reminded, escalated, expired, firstSeenAt) are
   * sticky: a reconciler refresh must never un-fire a reminder.
   */
  upsertPending(record, nowMs) {
    const now = new Date(nowMs || Date.now()).toISOString();
    return this.transact((data) => {
      const existing = data.pending[record.key] || {};
      const merged = { ...existing };
      for (const [k, v] of Object.entries(record)) {
        if (v !== undefined && v !== null) merged[k] = v;
      }
      merged.firstSeenAt = existing.firstSeenAt || now;
      merged.lastSeenAt = now;
      merged.reminded = Boolean(existing.reminded);
      merged.escalated = Boolean(existing.escalated);
      merged.expired = Boolean(existing.expired);
      if (existing.remindedAt) merged.remindedAt = existing.remindedAt;
      if (existing.escalatedAt) merged.escalatedAt = existing.escalatedAt;
      if (existing.expiredAt) merged.expiredAt = existing.expiredAt;
      if (!merged.state) merged.state = 'waiting';
      data.pending[record.key] = merged;
      return merged;
    });
  }

  updatePending(key, patch) {
    return this.transact((data) => {
      if (!data.pending[key]) return null;
      Object.assign(data.pending[key], patch);
      return data.pending[key];
    });
  }

  getPending(key) {
    this.load();
    return this.data.pending[key] || null;
  }

  listPendingForRepo(repoId) {
    this.load();
    return Object.values(this.data.pending).filter((r) => r.repoId === repoId);
  }

  listWaiting() {
    this.load();
    return Object.values(this.data.pending).filter((r) => r.state === 'waiting');
  }

  listWaitingForRepo(repoId) {
    return this.listPendingForRepo(repoId).filter((r) => r.state === 'waiting');
  }

  // Close one waiting row and record it as a digest outcome.
  closePending(key, outcome, nowMs) {
    const closedAt = new Date(nowMs || Date.now()).toISOString();
    return this.transact((data) => {
      const row = data.pending[key];
      if (!row || row.state !== 'waiting') return null;
      row.state = 'closed';
      row.outcome = outcome;
      row.closedAt = closedAt;
      data.outcomes.push({ ...row });
      if (data.outcomes.length > 5000) data.outcomes = data.outcomes.slice(-5000);
      return row;
    });
  }

  // Close every waiting row for a run (optionally sparing keys the
  // reconciler just confirmed are still pending). Returns closed rows.
  closePendingForRun(repoId, runId, outcome, nowMs, exceptKeys) {
    const closedAt = new Date(nowMs || Date.now()).toISOString();
    const except = exceptKeys || new Set();
    return this.transact((data) => {
      const closed = [];
      for (const row of Object.values(data.pending)) {
        if (row.repoId !== repoId || row.runId !== runId || row.state !== 'waiting') continue;
        if (except.has(row.key)) continue;
        row.state = 'closed';
        row.outcome = outcome;
        row.closedAt = closedAt;
        data.outcomes.push({ ...row });
        closed.push(row);
      }
      if (data.outcomes.length > 5000) data.outcomes = data.outcomes.slice(-5000);
      return closed;
    });
  }

  listOutcomesForRepo(repoId) {
    this.load();
    return this.data.outcomes.filter((o) => o.repoId === repoId);
  }

  setTrackingIssue(repoId, issueNumber) {
    this.transact((data) => { data.trackingIssues[repoId] = issueNumber; });
  }

  getTrackingIssue(repoId) {
    this.load();
    return this.data.trackingIssues[repoId] || null;
  }

  setDigest(repoId, weekKey, issueNumber) {
    this.transact((data) => {
      data.digests[`${repoId}:${weekKey}`] = { issueNumber, updatedAt: new Date().toISOString() };
    });
  }

  getDigest(repoId, weekKey) {
    this.load();
    return this.data.digests[`${repoId}:${weekKey}`] || null;
  }

  appendEvent(entry) {
    this.transact((data) => {
      data.events.push({ at: new Date().toISOString(), ...entry });
      if (data.events.length > 5000) data.events = data.events.slice(-5000);
    });
  }
}

module.exports = { Store };
