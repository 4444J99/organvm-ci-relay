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
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }
  });
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export async function installationToken(appId, privateKey, installationId) {
  const jwt = appJwt(appId, privateKey);
  const result = await request(`/app/installations/${installationId}/access_tokens`, jwt, { method: 'POST' });
  return result.token;
}

export async function verifyCurrentPullRequest(token, repository, result) {
  const [pr, main, run] = await Promise.all([
    request(`/repos/${repository}/pulls/${result.prNumber}`, token),
    request(`/repos/${repository}/git/ref/heads/main`, token),
    request(`/repos/${repository}/actions/runs/${result.runId}`, token)
  ]);
  if (pr.state !== 'open') throw new Error('PR is not open');
  if (pr.head.sha !== result.headSha || run.head_sha !== result.headSha) throw new Error('stale or mismatched candidate SHA');
  if (pr.base.ref !== 'main' || pr.base.sha !== main.object.sha) throw new Error('candidate is not based on current main');
  if (run.path !== TRUSTED_WORKFLOW_PATH || run.event !== 'pull_request_target' || run.conclusion !== 'success') throw new Error('workflow identity or result mismatch');
  return { ...result, baseSha: main.object.sha, detailsUrl: run.html_url };
}

export async function publishCheck(token, repository, result) {
  return request(`/repos/${repository}/check-runs`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkRunBody(result, result.detailsUrl))
  });
}

import { TRUSTED_WORKFLOW_PATH, checkRunBody } from './admission.mjs';
