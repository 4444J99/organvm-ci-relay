import crypto from 'node:crypto';

const api = 'https://api.github.com';

function b64url(value) { return Buffer.from(value).toString('base64url'); }

export function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const input = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

async function request(path, token, options = {}, format = 'json') {
  const response = await fetch(`${api}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(1000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
  return response.status === 204 ? null : format === 'text' ? response.text() : response.json();
}

export async function installationToken(appId, privateKey, installationId) {
  const jwt = appJwt(appId, privateKey);
  const result = await request(`/app/installations/${installationId}/access_tokens`, jwt, { method: 'POST' });
  return result.token;
}

export async function verifyCurrentPullRequest(token, repository, result, repositoryId = process.env.REPOSITORY_ID) {
  const [pr, main, runs] = await Promise.all([
    request(`/repos/${repository}/pulls/${result.prNumber}`, token),
    request(`/repos/${repository}/git/ref/heads/main`, token),
    request(`/repos/${repository}/actions/workflows/relay-policy.yml/runs?event=pull_request_target&head_sha=${result.headSha}&per_page=100`, token)
  ]);
  if (!Array.isArray(runs.workflow_runs) || !Number.isSafeInteger(runs.total_count) ||
      runs.total_count !== runs.workflow_runs.length || runs.total_count > 100) throw new Error('workflow history is incomplete');
  const matching = runs.workflow_runs.filter(run => run.head_sha === result.headSha &&
    run.path === TRUSTED_WORKFLOW_PATH && run.event === 'pull_request_target' &&
    run.pull_requests?.some(candidate => candidate.number === result.prNumber));
  if (matching.some(run => !Number.isSafeInteger(run.run_number) || run.run_number < 1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)) throw new Error('workflow ordering identity is invalid');
  matching.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  if (!matching.length) throw new Error('trusted workflow run is absent');
  const run = await request(`/repos/${repository}/actions/runs/${matching[0].id}`, token);
  const current = evaluateWorkflowRun({ repository: run.repository, workflow_run: run }, repository, repositoryId);
  if (!current.eligible || current.prNumber !== result.prNumber) throw new Error('workflow identity mismatch');
  if (pr.state !== 'open') throw new Error('PR is not open');
  if (pr.head.sha !== result.headSha || run.head_sha !== result.headSha) throw new Error('stale or mismatched candidate SHA');
  if (pr.base.ref !== 'main' || pr.base.sha !== main.object.sha) throw new Error('candidate is not based on current main');
  if (!current.admitted) return { ...current, detailsUrl: run.html_url };
  // Run pull_requests associations are mutable; only the executed job's log is
  // evidence of what actions/checkout actually checked out for this evaluation.
  const jobs = await request(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, token);
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || jobs.total_count > 100) throw new Error('workflow job history is incomplete');
  const policies = jobs.jobs.filter(job => job.name === 'Relay trust policy');
  if (policies.length !== 1 || policies[0].conclusion !== 'success') throw new Error('trusted policy job did not succeed');
  const job = policies[0];
  if (!Number.isSafeInteger(job.id) || job.id <= 0) throw new Error('trusted policy job identity is invalid');
  for (const name of ['Check out the trusted policy source', 'Fetch the exact pull-request head and freeze executable policy',
    'Verify the candidate with the trusted base verifier', 'Verify every registered operational SHA exists', 'Regress the trusted base verifier']) {
    const steps = job.steps?.filter(step => step.name === name) ?? [];
    if (steps.length !== 1 || steps[0].conclusion !== 'success') throw new Error('trusted policy step did not execute successfully');
  }
  const logs = await request(`/repos/${repository}/actions/jobs/${job.id}/logs`, token, {}, 'text');
  const proof = parseTrustedCheckout(logs);
  if (proof.baseSha !== main.object.sha || proof.headSha !== result.headSha) {
    return { ...current, admitted: false, reason: 'trusted checkout does not match current base/head', detailsUrl: run.html_url };
  }
  return { ...current, baseSha: proof.baseSha, checkoutJobId: job.id,
    checkoutLogSha256: crypto.createHash('sha256').update(logs).digest('hex'), detailsUrl: run.html_url };
}

export function parseTrustedCheckout(logs) {
  if (typeof logs !== 'string' || logs.length > 2 * 1024 * 1024) throw new Error('trusted checkout log is not bounded text');
  const checkouts = [...logs.matchAll(/^\d{4}-\d{2}-\d{2}T[^\s]+Z \[command\]\/usr\/bin\/git checkout --progress --force ([0-9a-f]{40})\r?$/gm)];
  const bases = [...logs.matchAll(/^\d{4}-\d{2}-\d{2}T[^\s]+Z {3}BASE_SHA: ([0-9a-f]{40})\r?$/gm)];
  const heads = [...logs.matchAll(/^\d{4}-\d{2}-\d{2}T[^\s]+Z {3}HEAD_SHA: ([0-9a-f]{40})\r?$/gm)];
  if (checkouts.length !== 1 || bases.length !== 1 || heads.length !== 1 || checkouts[0][1] !== bases[0][1]) throw new Error('trusted checkout log identity is ambiguous or absent');
  return { baseSha: checkouts[0][1], headSha: heads[0][1] };
}

export async function startCheck(token, repository, result) {
  const body = checkRunBody(result, undefined);
  delete body.conclusion;
  body.status = 'in_progress';
  body.output = { title: 'Trusted relay admission pending', summary: 'GitHub holds this admission attempt until its exact-head evaluation completes.' };
  const check = await request(`/repos/${repository}/check-runs`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!Number.isSafeInteger(check.id) || check.id <= 0 || check.head_sha !== result.headSha || check.name !== CHECK_NAME) throw new Error('pending check identity mismatch');
  return check;
}

export async function publishCheck(token, repository, result) {
  if (!Number.isSafeInteger(result.checkId) || result.checkId <= 0) throw new Error('durable pending check is required');
  const body = checkRunBody(result, result.detailsUrl);
  delete body.head_sha;
  return request(`/repos/${repository}/check-runs/${result.checkId}`, token, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

import { CHECK_NAME, TRUSTED_WORKFLOW_PATH, checkRunBody, evaluateWorkflowRun } from './admission.mjs';
