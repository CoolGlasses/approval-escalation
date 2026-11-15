'use strict';
/*
 * Pure policy + parsing + rendering for Deployment Approval
 * Escalation. No I/O: the server, reconciler, actions and sweep all
 * funnel through here so the behaviour is testable without GitHub.
 *
 * A tracked pending deployment ("row") looks like:
 *   { key, installationId, repoId, repoFullName, owner, repoName,
 *     runId, runUrl, workflowName, headBranch, headSha,
 *     environmentId, environmentName,
 *     reviewers: [{ type:'User'|'Team', id, login?, slug?, name? }],
 *     reviewerUsers: [login], reviewerTeams: [slug],
 *     waitingSince, firstSeenAt, lastSeenAt,
 *     reminded, remindedAt, escalated, escalatedAt,
 *     expired, expiredAt, state: 'waiting'|'closed',
 *     outcome, closedAt }
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

const CONFIG_PATH = '.github/approval-escalation.yml';
const TRACKING_ISSUE_TITLE = 'Deployment approvals waiting';

const DEFAULT_POLICY = {
  remind_after_hours: 4,
  escalate_after_hours: 24,
  escalation_mentions: [],
  auto_reject_after_hours: null, // null = off
  digest_weekday: 1, // Monday (JS getDay() numbering: 0=Sun..6=Sat)
};

/* ---------------- policy config parsing ----------------
 * A deliberately small YAML subset — flat `key: value` scalars,
 * inline lists `[a, b]`, and block lists:
 *   escalation_mentions:
 *     - alice
 *     - acme/platform
 * Unknown keys are ignored; unparseable values fall back to defaults.
 */
function parseScalar(raw) {
  const v = String(raw).trim().replace(/^['"]|['"]$/g, '');
  if (v === '' || /^(null|~|off|none)$/i.test(v)) return null;
  if (/^(true|yes)$/i.test(v)) return true;
  if (/^(false|no)$/i.test(v)) return false;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

function normalizeMention(m) {
  return String(m || '').trim().replace(/^@/, '').replace(/^['"]|['"]$/g, '');
}

function hoursOrDefault(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function hoursOrNull(value, fallback) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function parsePolicyConfig(text) {
  const policy = { ...DEFAULT_POLICY, escalation_mentions: [] };
  if (!text) return policy;
  const lines = String(text).split(/\r?\n/);
  let listKey = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey === 'escalation_mentions') {
      const m = normalizeMention(parseScalar(item[1]));
      if (m) policy.escalation_mentions.push(m);
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) { listKey = null; continue; }
    const key = kv[1];
    const value = kv[2].trim();
    listKey = null;
    if (key === 'escalation_mentions') {
      if (value.startsWith('[')) {
        policy.escalation_mentions = value.replace(/^\[|\]$/g, '').split(',')
          .map((s) => normalizeMention(parseScalar(s))).filter(Boolean);
      } else if (value) {
        const m = normalizeMention(parseScalar(value));
        policy.escalation_mentions = m ? [m] : [];
      } else {
        listKey = 'escalation_mentions'; // block list follows
      }
      continue;
    }
    if (!(key in DEFAULT_POLICY)) continue;
    const parsed = parseScalar(value);
    if (key === 'digest_weekday') {
      if (typeof parsed === 'string' && WEEKDAYS[parsed.toLowerCase()] !== undefined) policy.digest_weekday = WEEKDAYS[parsed.toLowerCase()];
      else if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 6) policy.digest_weekday = parsed;
    } else if (key === 'auto_reject_after_hours') {
      policy.auto_reject_after_hours = hoursOrNull(parsed, DEFAULT_POLICY.auto_reject_after_hours);
    } else {
      policy[key] = hoursOrDefault(parsed, DEFAULT_POLICY[key]);
    }
  }
  return policy;
}

function normalizePolicy(policy) {
  if (!policy) return { ...DEFAULT_POLICY };
  return {
    remind_after_hours: hoursOrDefault(policy.remind_after_hours, DEFAULT_POLICY.remind_after_hours),
    escalate_after_hours: hoursOrDefault(policy.escalate_after_hours, DEFAULT_POLICY.escalate_after_hours),
    escalation_mentions: Array.isArray(policy.escalation_mentions)
      ? policy.escalation_mentions.map(normalizeMention).filter(Boolean)
      : [],
    auto_reject_after_hours: policy.auto_reject_after_hours === undefined
      ? DEFAULT_POLICY.auto_reject_after_hours
      : hoursOrNull(policy.auto_reject_after_hours, null),
    digest_weekday: Number.isInteger(policy.digest_weekday) ? policy.digest_weekday : DEFAULT_POLICY.digest_weekday,
  };
}

/* ---------------- pending-deployment parsing ---------------- */

function pendingKey(repoId, runId, environmentId, environmentName) {
  return `${repoId}:${runId}:${environmentId != null ? environmentId : `name:${environmentName}`}`;
}

function parseReviewers(deployment) {
  const reviewers = [];
  const users = [];
  const teams = [];
  for (const entry of (deployment && deployment.reviewers) || []) {
    const r = entry.reviewer || {};
    if (entry.type === 'User' || r.login) {
      reviewers.push({ type: 'User', id: r.id != null ? r.id : null, login: r.login || null });
      if (r.login && !users.includes(r.login)) users.push(r.login);
    } else if (entry.type === 'Team' || r.slug) {
      reviewers.push({ type: 'Team', id: r.id != null ? r.id : null, slug: r.slug || null, name: r.name || null });
      if (r.slug && !teams.includes(r.slug)) teams.push(r.slug);
    }
  }
  return { reviewers, users, teams };
}

/*
 * Convert one run + its GET pending_deployments response into tracked
 * rows. `repo` is the store's repo record ({ id, owner, name,
 * fullName, installationId }). waitingSince prefers the deployment's
 * own wait_timer_started_at, then the run's created_at.
 */
function parsePendingDeployments({ repo, run, deployments, nowMs }) {
  const now = nowMs || Date.now();
  const rows = [];
  for (const dep of deployments || []) {
    const env = dep.environment || {};
    const environmentId = env.id != null ? env.id : null;
    const environmentName = env.name || 'unknown';
    const { reviewers, users, teams } = parseReviewers(dep);
    const waitingSince = dep.wait_timer_started_at || dep.created_at || run.created_at || run.updated_at || new Date(now).toISOString();
    rows.push({
      key: pendingKey(repo.id, run.id, environmentId, environmentName),
      installationId: repo.installationId,
      repoId: repo.id,
      repoFullName: repo.fullName || `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      repoName: repo.name,
      runId: run.id,
      runUrl: run.html_url || null,
      workflowName: run.name || null,
      headBranch: run.head_branch || null,
      headSha: run.head_sha || null,
      environmentId,
      environmentName,
      reviewers,
      reviewerUsers: users,
      reviewerTeams: teams,
      waitingSince,
      state: 'waiting',
    });
  }
  return rows;
}

/* ---------------- the policy engine ---------------- */

function ageHours(row, nowMs) {
  const t = Date.parse(row.waitingSince);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (nowMs - t) / HOUR);
}

/*
 * Decide what (if anything) to do about one waiting row right now.
 * At most one action per evaluation: auto-reject outranks escalation,
 * which outranks (and subsumes) a reminder. Boundaries are inclusive:
 * a row exactly at the threshold fires.
 */
function evaluatePending(row, policyInput, nowMs) {
  if (!row || row.state !== 'waiting') return [];
  const policy = normalizePolicy(policyInput);
  const age = ageHours(row, nowMs);
  const base = { runId: row.runId, environmentName: row.environmentName, ageHours: age };

  if (policy.auto_reject_after_hours !== null && !row.expired && age >= policy.auto_reject_after_hours) {
    return [{ type: 'auto-reject', tier: 'expire', ...base }];
  }
  if (!row.escalated && age >= policy.escalate_after_hours) {
    return [{ type: 'escalate', tier: 'escalate', ...base }];
  }
  if (!row.reminded && !row.escalated && age >= policy.remind_after_hours) {
    return [{ type: 'remind', tier: 'remind', ...base }];
  }
  return [];
}

/* ---------------- mentions + rendering ---------------- */

function teamMention(owner, slug) {
  if (!slug) return '';
  return slug.includes('/') ? `@${slug}` : `@${owner}/${slug}`;
}

function reviewerMentions(row) {
  const out = [];
  for (const login of row.reviewerUsers || []) out.push(`@${login}`);
  for (const slug of row.reviewerTeams || []) {
    const m = teamMention(row.owner, slug);
    if (m) out.push(m);
  }
  return out;
}

function escalationMentions(policyInput) {
  const policy = normalizePolicy(policyInput);
  return policy.escalation_mentions.map((m) => (m.startsWith('@') ? m : `@${m}`));
}

function formatAge(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function rowLine(row, nowMs) {
  const age = formatAge(ageHours(row, nowMs));
  const runRef = row.runUrl ? `[run ${row.runId}](${row.runUrl})` : `run ${row.runId}`;
  const who = reviewerMentions(row).join(' ') || 'no reviewers listed';
  const wf = row.workflowName ? ` · ${row.workflowName}` : '';
  return `- **${row.environmentName}** — ${runRef}${wf} · waiting ${age} · reviewers: ${who}`;
}

function buildTrackingIssueBody(repoFullName, rows, nowMs) {
  const waiting = (rows || []).filter((r) => r.state === 'waiting')
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
  const lines = [
    `Deployment approvals currently waiting in **${repoFullName}**.`,
    '',
    'This issue is maintained by Deployment Approval Escalation: reminders and escalations land as comments here, one per run per tier. Approve or reject from the run itself — this issue is the waiting room, not the door.',
    '',
  ];
  if (!waiting.length) lines.push('_Nothing is waiting right now._');
  else for (const row of waiting) lines.push(rowLine(row, nowMs));
  return lines.join('\n');
}

function commentBody(kind, row, policyInput, nowMs) {
  const age = formatAge(ageHours(row, nowMs));
  const runRef = row.runUrl ? `[run ${row.runId}](${row.runUrl})` : `run ${row.runId}`;
  if (kind === 'remind') {
    const mentions = reviewerMentions(row).join(' ');
    return `⏳ **Approval reminder:** the **${row.environmentName}** deployment for ${runRef} has been waiting ${age} with no decision.${mentions ? `\n\n${mentions} — a decision (approve or reject) clears this.` : ''}`;
  }
  if (kind === 'escalate') {
    const mentions = escalationMentions(policyInput).join(' ');
    return `🚨 **Approval escalation:** the **${row.environmentName}** deployment for ${runRef} has been waiting ${age} — past the escalation threshold.${mentions ? `\n\n${mentions} — this one needs a decision.` : ''}`;
  }
  if (kind === 'expire') {
    return `⛔ **Auto-rejected:** the **${row.environmentName}** deployment for ${runRef} waited ${age}, past this repository's configured expiry. It has been rejected so the run stops hanging. Re-run the workflow to deploy.`;
  }
  return `Deployment Approval Escalation: ${kind} for ${runRef}.`;
}

/* ---------------- digest ---------------- */

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * DAY));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildDigestMarkdown(repoFullName, { pending, outcomes }, nowMs) {
  const now = nowMs || Date.now();
  const since = now - 7 * DAY;
  const recent = (outcomes || []).filter((o) => Date.parse(o.closedAt) >= since);
  const waits = recent
    .map((o) => (Date.parse(o.closedAt) - Date.parse(o.waitingSince)) / HOUR)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const expiries = recent.filter((o) => o.outcome === 'auto_rejected').length;
  const med = median(waits);
  const waiting = (pending || []).filter((r) => r.state === 'waiting')
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));

  const lines = [
    `## Deployment approvals — week in review`,
    '',
    `Repository: **${repoFullName}** · window: last 7 days`,
    '',
    `- Approvals that waited and resolved: **${recent.length}**`,
    `- Median wait: **${med === null ? 'n/a' : formatAge(med)}**`,
    `- Auto-rejected at expiry: **${expiries}**`,
    `- Still waiting now: **${waiting.length}**`,
  ];
  if (waiting.length) {
    lines.push('', '### Still waiting', '');
    for (const row of waiting) lines.push(rowLine(row, now));
  }
  if (recent.length) {
    lines.push('', '### Resolved this week', '');
    for (const o of recent.slice().sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))) {
      const wait = formatAge((Date.parse(o.closedAt) - Date.parse(o.waitingSince)) / HOUR);
      lines.push(`- **${o.environmentName}** — run ${o.runId} · waited ${wait} · outcome: ${o.outcome}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  HOUR,
  DAY,
  CONFIG_PATH,
  TRACKING_ISSUE_TITLE,
  DEFAULT_POLICY,
  parsePolicyConfig,
  normalizePolicy,
  pendingKey,
  parseReviewers,
  parsePendingDeployments,
  ageHours,
  evaluatePending,
  reviewerMentions,
  escalationMentions,
  formatAge,
  buildTrackingIssueBody,
  commentBody,
  isoWeekKey,
  median,
  buildDigestMarkdown,
};
