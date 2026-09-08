import crypto from 'node:crypto';

export const CHECK_NAME = 'Relay admission / trusted';
export const TRUSTED_WORKFLOW_PATH = '.github/workflows/relay-policy.yml';

export function verifyWebhook(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=') || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function evaluateWorkflowRun(payload, expectedRepository) {
  const run = payload.workflow_run;
  const repo = payload.repository;
  if (!run || !repo) return { admitted: false, reason: 'missing workflow_run or repository' };
  if (repo.full_name !== expectedRepository) return { admitted: false, reason: 'repository name mismatch' };
  if (String(repo.id) !== String(process.env.REPOSITORY_ID || repo.id)) return { admitted: false, reason: 'repository ID mismatch' };
  if (run.path !== TRUSTED_WORKFLOW_PATH) return { admitted: false, reason: 'untrusted workflow path' };
  if (run.event !== 'pull_request_target') return { admitted: false, reason: 'untrusted workflow event' };
  if (run.status !== 'completed' || run.conclusion !== 'success') return { admitted: false, reason: 'trusted workflow did not succeed' };
  if (!/^[0-9a-f]{40}$/.test(run.head_sha || '')) return { admitted: false, reason: 'invalid candidate SHA' };
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) return { admitted: false, reason: 'run must identify exactly one PR' };
  return { admitted: true, headSha: run.head_sha, prNumber: run.pull_requests[0].number, runId: run.id, attempt: run.run_attempt || 1 };
}

export function checkRunBody(result, detailsUrl) {
  return {
    name: CHECK_NAME,
    head_sha: result.headSha,
    status: 'completed',
    conclusion: result.admitted ? 'success' : 'failure',
    external_id: `relay-admission:${result.runId}:${result.attempt}:${result.headSha}`,
    details_url: detailsUrl,
    output: {
      title: result.admitted ? 'Trusted relay admission succeeded' : 'Trusted relay admission rejected',
      summary: result.admitted ? 'The base-controlled relay policy admitted this exact PR head.' : result.reason
    }
  };
}
