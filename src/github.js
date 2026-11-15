'use strict';
/*
 * GitHub App plumbing: webhook signature verification, App JWT ->
 * installation access token exchange, and the REST surface Deployment
 * Approval Escalation needs (workflow runs, pending deployments,
 * pending-deployment review, repo config files, tracking/digest
 * issues and comments). No dependencies: Node's crypto + fetch.
 * Mirrors the SameTree / Bot-PR Janitor client shape.
 */
const crypto = require('crypto');

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeAppJwt(appId, privateKeyPem, nowSeconds) {
  const now = nowSeconds || Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 540, iss: String(appId) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

function makeGithubClient({ appId, privateKeyPem, fetchImpl, apiBase }) {
  const doFetch = fetchImpl || fetch;
  const base = apiBase || 'https://api.github.com';
  const tokenCache = new Map(); // installationId -> { token, expiresAtMs }

  async function api(token, method, path, body, opts) {
    const res = await doFetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Deployment-Approval-Escalation',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (opts && opts.allow404 && res.status === 404) return null;
    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`GitHub API ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function getInstallationToken(installationId) {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;
    const jwt = makeAppJwt(appId, privateKeyPem);
    const data = await api(jwt, 'POST', `/app/installations/${installationId}/access_tokens`);
    tokenCache.set(installationId, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
    return data.token;
  }

  async function withToken(installationId, method, path, body, opts) {
    const token = await getInstallationToken(installationId);
    return api(token, method, path, body, opts);
  }

  return {
    // Recent workflow runs for a repo (newest first, GitHub's order).
    async listWorkflowRuns(installationId, owner, repo) {
      const out = [];
      let page = 1;
      for (;;) {
        const data = await withToken(installationId, 'GET', `/repos/${owner}/${repo}/actions/runs?per_page=100&page=${page}`);
        const runs = (data && data.workflow_runs) || [];
        out.push(...runs);
        if (runs.length < 100) break;
        page++;
      }
      return out;
    },

    // The deployments a run is currently waiting on. GitHub returns a
    // top-level JSON array; each entry carries the environment and the
    // reviewers (users/teams) whose approval is required.
    async getPendingDeployments(installationId, owner, repo, runId) {
      const data = await withToken(installationId, 'GET', `/repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`);
      if (Array.isArray(data)) return data;
      return (data && data.pending_deployments) || [];
    },

    // Approve or reject pending deployments for a run. We only ever
    // send state:"rejected" (auto-reject); approvals stay human.
    async reviewPendingDeployments(installationId, owner, repo, runId, { environmentIds, state, comment }) {
      return withToken(installationId, 'POST', `/repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`, {
        environment_ids: environmentIds,
        state,
        comment: comment || '',
      });
    },

    // Returns decoded file text, or null when the path does not exist.
    async getFileContent(installationId, owner, repo, path, ref) {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const data = await withToken(installationId, 'GET', `/repos/${owner}/${repo}/contents/${path}${q}`, undefined, { allow404: true });
      if (!data || !data.content) return null;
      return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
    },

    async listIssues(installationId, owner, repo, state) {
      const out = [];
      let page = 1;
      for (;;) {
        const data = await withToken(installationId, 'GET', `/repos/${owner}/${repo}/issues?state=${state || 'open'}&per_page=100&page=${page}`);
        const issues = data || [];
        // The issues endpoint also returns PRs; callers filter.
        out.push(...issues.filter((i) => !i.pull_request));
        if (issues.length < 100) break;
        page++;
      }
      return out;
    },

    async createIssue(installationId, owner, repo, title, body) {
      return withToken(installationId, 'POST', `/repos/${owner}/${repo}/issues`, { title, body });
    },

    async updateIssue(installationId, owner, repo, number, body) {
      return withToken(installationId, 'PATCH', `/repos/${owner}/${repo}/issues/${number}`, { body });
    },

    async createComment(installationId, owner, repo, number, body) {
      return withToken(installationId, 'POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
    },
  };
}

module.exports = { verifyWebhookSignature, makeAppJwt, makeGithubClient };
