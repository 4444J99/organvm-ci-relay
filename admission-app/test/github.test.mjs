import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCurrentPullRequest, parseTrustedCheckout, startCheck, publishCheck } from '../src/github.mjs';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const repository = { id: 1350979676, full_name: '4444J99/organvm-ci-relay' };
const result = { eligible: true, admitted: true, headSha: sha, prNumber: 30, runId: 99, attempt: 1 };
function fixture() {
  const pr = { number: 30, state: 'open', head: { sha }, base: { ref: 'main', sha: base, repo: structuredClone(repository) } };
  const run = { id: 99, run_number: 9, run_attempt: 1, repository: structuredClone(repository), head_sha: sha,
    path: '.github/workflows/relay-policy.yml', event: 'pull_request_target', status: 'completed',
    conclusion: 'success', html_url: 'https://github.com/4444J99/organvm-ci-relay/actions/runs/99',
    pull_requests: [structuredClone(pr)] };
  return { pr, main: { object: { sha: base } }, run, total: 1, checkoutBase: base, checkoutHead: sha };
}
async function verify(data) {
  const previous = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, status: 200, text: async () => checkoutLog(data.checkoutBase, data.checkoutHead), json: async () => {
    if (url.includes('/attempts/')) return { total_count: 1, jobs: [{ id: 500, name: 'Relay trust policy', conclusion: 'success', steps: ['Check out the trusted policy source', 'Fetch the exact pull-request head and freeze executable policy', 'Verify the candidate with the trusted base verifier', 'Verify every registered operational SHA exists', 'Regress the trusted base verifier'].map(name => ({ name, conclusion: 'success' })) }] };
    if (url.includes('/pulls/')) return data.pr;
    if (url.includes('/git/ref/')) return data.main;
    if (url.includes('/actions/workflows/')) return { total_count: data.total, workflow_runs: [data.run] };
    return data.run;
  } });
  try { return await verifyCurrentPullRequest('token', repository.full_name, result, repository.id); }
  finally { globalThis.fetch = previous; }
}
test('revalidates current PR, base, latest run and repository', async () => {
  const out = await verify(fixture()); assert.equal(out.admitted, true); assert.equal(out.baseSha, base);
});
for (const [name, mutate, diagnostic] of [
  ['stale candidate', d => { d.pr.head.sha = 'c'.repeat(40); }, /stale or mismatched/],
  ['advanced main', d => { d.main.object.sha = 'c'.repeat(40); }, /not based/],
  ['forged workflow', d => { d.run.path = 'forgery.yml'; }, /trusted workflow run is absent/],
  ['forged repository ID', d => { d.run.repository.id = 9; }, /workflow identity/],
  ['partial run history', d => { d.total = 101; }, /incomplete/]
]) test(`rejects ${name}`, async () => { const data = fixture(); mutate(data); await assert.rejects(verify(data), diagnostic); });
for (const state of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required']) {
  test(`later ${state} invalidates earlier success even for delayed success webhook`, async () => {
    const data = fixture(); data.run.run_attempt = 2; data.run.conclusion = state;
    const out = await verify(data); assert.equal(out.admitted, false); assert.equal(out.attempt, 2);
  });
}
test('a later run supersedes an older webhook run ID', async () => {
  const data = fixture(); data.run.id = 100; data.run.run_number = 10; data.run.conclusion = 'failure';
  const out = await verify(data); assert.equal(out.runId, 100); assert.equal(out.admitted, false);
});
test('an in-progress rerun cannot retain success', async () => {
  const data = fixture(); data.run.status = 'in_progress'; data.run.conclusion = null;
  assert.equal((await verify(data)).admitted, false);
});
test('immutable checkout base is checked separately from mutable run association', async () => {
  const data = fixture(); data.checkoutBase = 'd'.repeat(40);
  const out = await verify(data); assert.equal(out.admitted, false); assert.match(out.reason, /trusted checkout/);
});
test('mutable run base does not substitute for actual trusted checkout', async () => {
  const data = fixture(); data.run.pull_requests[0].base.sha = 'd'.repeat(40);
  assert.equal((await verify(data)).baseSha, base);
});

function checkoutLog(baseSha, headSha) {
  return `2026-09-08T15:05:36.000Z [command]/usr/bin/git checkout --progress --force ${baseSha}\n2026-09-08T15:05:36.100Z   BASE_SHA: ${baseSha}\n2026-09-08T15:05:36.101Z   HEAD_SHA: ${headSha}\n`;
}
test('checkout proof rejects missing, repeated and injected-looking output', () => {
  const logs = checkoutLog(base, sha);
  assert.deepEqual(parseTrustedCheckout(logs), { baseSha: base, headSha: sha });
  assert.throws(() => parseTrustedCheckout(logs + logs), /ambiguous/);
  assert.throws(() => parseTrustedCheckout(logs.replace('[command]', 'echo [command]')), /absent/);
  assert.throws(() => parseTrustedCheckout(''), /absent/);
});
test('completion updates its durable pending check instead of creating a late success', async () => {
  const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, method: options.method, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ id: 100, name: 'Relay admission / trusted', head_sha: sha }) }; };
  try {
    const pending = await startCheck('token', repository.full_name, result);
    await publishCheck('token', repository.full_name, { ...result, checkId: pending.id });
    assert.equal(calls[0].body.status, 'in_progress'); assert.equal(calls[0].body.conclusion, undefined);
    assert.equal(calls[1].method, 'PATCH'); assert.ok(calls[1].url.endsWith('/check-runs/100'));
    await assert.rejects(publishCheck('token', repository.full_name, result), /durable pending check/);
  } finally { globalThis.fetch = previous; }
});
