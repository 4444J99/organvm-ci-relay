import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCurrentPullRequest } from '../src/github.mjs';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const result = { admitted: true, headSha: sha, prNumber: 30, runId: 99, attempt: 1 };

function responses({ prHead = sha, prBase = base, main = base, runHead = sha, path = '.github/workflows/relay-policy.yml', event = 'pull_request_target', conclusion = 'success' } = {}) {
  return [
    { state: 'open', head: { sha: prHead }, base: { ref: 'main', sha: prBase } },
    { object: { sha: main } },
    { head_sha: runHead, path, event, conclusion, html_url: 'https://github.example/run/99' }
  ];
}

async function withFetch(payloads, operation) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payloads.shift() });
  try { return await operation(); } finally { globalThis.fetch = previous; }
}

test('revalidates the live PR, current base, and workflow identity', async () => {
  const verified = await withFetch(responses(), () => verifyCurrentPullRequest('token', 'owner/repo', result));
  assert.equal(verified.baseSha, base);
});

for (const [name, options, diagnostic] of [
  ['stale candidate head', { prHead: 'c'.repeat(40) }, /stale or mismatched/],
  ['advanced main', { main: 'c'.repeat(40) }, /not based on current main/],
  ['forged workflow path', { path: '.github/workflows/forgery.yml' }, /workflow identity/],
  ['non-success result', { conclusion: 'failure' }, /workflow identity/]
]) test(`rejects ${name}`, async () => {
  await assert.rejects(withFetch(responses(options), () => verifyCurrentPullRequest('token', 'owner/repo', result)), diagnostic);
});
