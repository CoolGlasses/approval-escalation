'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWebhookSignature, makeAppJwt, makeGithubClient } = require('../src/github');

const SECRET = 'test-secret';
function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

test('webhook signature: valid passes, tampered/missing fails', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"a":2}'), sign(body), SECRET), false);
  assert.equal(verifyWebhookSignature(body, null, SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body), ''), false);
});

test('app JWT: RS256 structure and claims', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = makeAppJwt(12345, pem, 1_700_000_000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(payload.iss, '12345');
  assert.equal(payload.exp - payload.iat, 600);
});

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('github client: token exchange, pending-deployments GET, review POST body', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const requests = [];
  const pendingFixture = [{ environment: { id: 7, name: 'production' }, reviewers: [] }];
  async function fetchImpl(url, opts) {
    requests.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/app/installations/555/access_tokens')) {
      return jsonResponse(201, { token: 'inst-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (url.includes('/pending_deployments') && opts.method === 'GET') return jsonResponse(200, pendingFixture);
    if (url.includes('/pending_deployments') && opts.method === 'POST') return jsonResponse(200, []);
    throw new Error('unexpected request: ' + url);
  }
  const github = makeGithubClient({ appId: 999, privateKeyPem: pem, fetchImpl });

  const deps = await github.getPendingDeployments(555, 'acme', 'widgets', 9001);
  assert.deepEqual(deps, pendingFixture);
  const getReq = requests.find((r) => r.method === 'GET');
  assert.match(getReq.url, /\/repos\/acme\/widgets\/actions\/runs\/9001\/pending_deployments$/);

  await github.reviewPendingDeployments(555, 'acme', 'widgets', 9001, { environmentIds: [7], state: 'rejected', comment: 'too late' });
  const postReq = requests.find((r) => r.method === 'POST' && r.url.includes('/pending_deployments'));
  assert.deepEqual(postReq.body, { environment_ids: [7], state: 'rejected', comment: 'too late' });
  // Token was exchanged once and cached for the second call.
  assert.equal(requests.filter((r) => r.url.includes('/access_tokens')).length, 1);
});
