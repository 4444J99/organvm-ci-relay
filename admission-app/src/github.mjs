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

async function request(path, token, options = {}) {
  const response = await fetch(`${api}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(1500),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
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
  matching.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  if (!matching.length) throw new Error('trusted workflow run is absent');
  const run = await request(`/repos/${repository}/actions/runs/${matching[0].id}`, token);
  const current = evaluateWorkflowRun({ repository: run.repository, workflow_run: run }, repository, repositoryId);
  if (!current.eligible || current.prNumber !== result.prNumber) throw new Error('workflow identity mismatch');
  if (pr.state !== 'open') throw new Error('PR is not open');
  if (pr.head.sha !== result.headSha || run.head_sha !== result.headSha) throw new Error('stale or mismatched candidate SHA');
  if (pr.base.ref !== 'main' || pr.base.sha !== main.object.sha) throw new Error('candidate is not based on current main');
  if (current.baseSha !== main.object.sha) return { ...current, admitted: false, reason: 'trusted evaluation predates current main', detailsUrl: run.html_url };
  return { ...current, baseSha: main.object.sha, detailsUrl: run.html_url };
}

export async function publishCheck(token, repository, result) {
  return request(`/repos/${repository}/check-runs`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkRunBody(result, result.detailsUrl))
  });
}

import { TRUSTED_WORKFLOW_PATH, checkRunBody, evaluateWorkflowRun } from './admission.mjs';
