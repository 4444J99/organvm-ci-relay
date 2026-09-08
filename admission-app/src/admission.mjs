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

export function evaluateWorkflowRun(payload, expectedRepository, expectedRepositoryId = process.env.REPOSITORY_ID) {
  const run = payload.workflow_run;
  const repo = payload.repository;
  if (!run || !repo) return { admitted: false, reason: 'missing workflow_run or repository' };
  if (repo.full_name !== expectedRepository) return { admitted: false, reason: 'repository name mismatch' };
  if (!/^[1-9][0-9]*$/.test(String(expectedRepositoryId)) || String(repo.id) !== String(expectedRepositoryId)) return { admitted: false, reason: 'repository ID mismatch' };
  if (run.path !== TRUSTED_WORKFLOW_PATH) return { admitted: false, reason: 'untrusted workflow path' };
  if (run.event !== 'pull_request_target') return { admitted: false, reason: 'untrusted workflow event' };
  if (!/^[0-9a-f]{40}$/.test(run.head_sha || '')) return { admitted: false, reason: 'invalid candidate SHA' };
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) return { admitted: false, reason: 'invalid run identity' };
  const matches = Array.isArray(run.pull_requests) ? run.pull_requests.filter(pr =>
    pr.head?.sha === run.head_sha && pr.base?.ref === 'main' &&
    String(pr.base?.repo?.id) === String(expectedRepositoryId) &&
    Number.isSafeInteger(pr.number) && pr.number > 0) : [];
  if (matches.length !== 1) return { admitted: false, reason: 'run must identify exactly one matching main PR' };
  const admitted = run.status === 'completed' && run.conclusion === 'success';
  return { eligible: true, admitted, reason: admitted ? undefined : 'trusted workflow did not succeed',
    headSha: run.head_sha, baseSha: matches[0].base.sha, prNumber: matches[0].number,
    runId: run.id, attempt: run.run_attempt };
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
