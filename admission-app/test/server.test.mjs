import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createAdmissionServer } from '../src/server.mjs';
const env = { APP_ID: '1', PRIVATE_KEY: 'test-key', WEBHOOK_SECRET: 'test-secret', REPOSITORY: '4444J99/organvm-ci-relay', REPOSITORY_ID: '1350979676', INSTALLATION_ID: '7' };
const sha = 'a'.repeat(40);
function body(conclusion = 'failure') { return JSON.stringify({ installation: { id: 7 }, repository: { id: 1350979676, full_name: env.REPOSITORY }, workflow_run: { id: 9, run_attempt: 2, head_sha: sha, path: '.github/workflows/relay-policy.yml', event: 'pull_request_target', status: 'completed', conclusion, pull_requests: [{ number: 30, head: { sha }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 1350979676 } } }] } }); }
async function withServer(dependencies, fn) {
  const server = createAdmissionServer(env, dependencies);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}/webhook`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function signed(raw) { return { method: 'POST', body: raw, headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', env.WEBHOOK_SECRET).update(raw).digest('hex') } }; }
test('failed trusted rerun publishes a failure decision', async () => {
  const published = [];
  await withServer({ installationToken: async () => 'token', verifyCurrentPullRequest: async (_t, _r, result) => result, publishCheck: async (_t, _r, result) => published.push(result) }, async url => {
    const response = await fetch(url, signed(body())); assert.equal(response.status, 202); assert.equal(await response.text(), 'rejected');
  });
  assert.equal(published.length, 1); assert.equal(published[0].admitted, false); assert.equal(published[0].attempt, 2);
});
test('provider exception body is absent from responses and logs', async () => {
  const logged = []; const old = console.error; console.error = value => logged.push(value);
  try {
    await withServer({ installationToken: async () => { throw new Error('private-input-secret'); } }, async url => {
      const response = await fetch(url, signed(body())); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-input-secret/);
    });
    assert.deepEqual(logged, []);
  } finally { console.error = old; }
});
test('dripped request is cut off by total deadline', async () => {
  await withServer({ readTimeout: 60 }, async url => {
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST' }, res => { assert.equal(res.statusCode, 408); res.resume(); res.on('end', resolve); });
      req.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
      const timer = setInterval(() => req.write('a'), 10);
      req.on('close', () => clearInterval(timer));
      req.write('a');
    });
    assert.ok(Date.now() - started < 1000);
  });
});
test('oversized declared body rejected without invoking provider', async () => {
  await withServer({ installationToken: async () => { throw new Error('must not run'); } }, async url => {
    await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Length': String(2 * 1024 * 1024) } }, res => { assert.equal(res.statusCode, 413); res.resume(); res.on('end', resolve); });
      req.on('error', reject); req.end();
    });
  });
});
