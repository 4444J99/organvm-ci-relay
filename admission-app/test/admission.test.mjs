import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CHECK_NAME, evaluateWorkflowRun, verifyWebhook } from '../src/admission.mjs';

const sha = 'a'.repeat(40);
const payload = { repository: { id: 1350979676, full_name: '4444J99/organvm-ci-relay' }, workflow_run: { id: 7, run_attempt: 1, path: '.github/workflows/relay-policy.yml', event: 'pull_request_target', status: 'completed', conclusion: 'success', head_sha: sha, pull_requests: [{ number: 29 }] } };

test('admits only the trusted successful exact-head run', () => assert.equal(evaluateWorkflowRun(payload, payload.repository.full_name).admitted, true));
for (const [name, mutate] of [
  ['forged workflow path', p => { p.workflow_run.path = '.github/workflows/forgery.yml'; }],
  ['duplicate or missing PR identity', p => { p.workflow_run.pull_requests.push({ number: 30 }); }],
  ['stale-shaped SHA', p => { p.workflow_run.head_sha = 'abc'; }],
  ['failed result', p => { p.workflow_run.conclusion = 'failure'; }],
  ['wrong repository', p => { p.repository.full_name = 'attacker/fork'; }]
]) test(`rejects ${name}`, () => { const p = structuredClone(payload); mutate(p); assert.equal(evaluateWorkflowRun(p, payload.repository.full_name).admitted, false); });

test('webhook verification is timing-safe and exact', () => {
  const body = Buffer.from(JSON.stringify(payload)); const secret = 'test-secret';
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyWebhook(body, sig, secret), true); assert.equal(verifyWebhook(Buffer.from('x'), sig, secret), false);
  assert.equal(verifyWebhook(body, [sig], secret), false);
});
test('check name is stable', () => assert.equal(CHECK_NAME, 'Relay admission / trusted'));
