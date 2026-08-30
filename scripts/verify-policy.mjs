import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => {
  throw new Error(message);
};
const config = JSON.parse(fs.readFileSync('config/targets.json', 'utf8'));
const workflow = fs.readFileSync(
  '.github/workflows/relay-process-environment.yml',
  'utf8',
);

if (config.schema !== 'organvm.relay-targets.v3') {
  fail('Unexpected target-registry schema');
}
if (config.policy?.require_public_source !== true) {
  fail('Public source must be mandatory');
}
if (config.policy?.require_exact_40_hex_sha !== true) {
  fail('Exact commit SHAs must be mandatory');
}
if (config.policy?.deny_floating_refs !== true) {
  fail('Floating refs must be denied');
}
if (config.policy?.receipt_branch !== 'receipts') {
  fail('The durable receipt branch must be receipts');
}
if (!Array.isArray(config.policy?.allowed_secrets) ||
    config.policy.allowed_secrets.length !== 0) {
  fail('Target jobs may not receive secrets');
}

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const families = new Set(['process-environment', 'python']);
for (const [name, profile] of Object.entries(config.profiles ?? {})) {
  if (!profilePattern.test(name)) fail(`Invalid profile: ${name}`);
  if (!families.has(profile.family)) fail(`Invalid profile family: ${name}`);
  const shellProfilePath = path.join('profiles', `${name}.sh`);
  if (!fs.existsSync(shellProfilePath)) {
    fail(`Missing relay-owned profile: ${name}`);
  }
  const shellProfile = fs.readFileSync(shellProfilePath, 'utf8');
  const externalGitUrls =
    shellProfile.match(/git\+https:\/\/[^\s'"]+/g) ?? [];
  for (const externalGitUrl of externalGitUrls) {
    if (!/\.git@[0-9a-f]{40}(?:#.*)?$/.test(externalGitUrl)) {
      fail(`Unpinned Git dependency in profile: ${name}`);
    }
  }
  if (profile.family === 'process-environment' &&
      !fs.existsSync(path.join('profiles', `${name}.ps1`))) {
    fail(`Missing Windows relay profile: ${name}`);
  }
}

const targetPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
for (const [target, entry] of Object.entries(config.targets ?? {})) {
  if (!targetPattern.test(target)) fail(`Invalid target: ${target}`);
  if (entry.visibility !== 'public') fail(`Non-public target: ${target}`);
  if (!/^[0-9]+$/.test(String(entry.stable_repository_id))) {
    fail(`Invalid stable repository ID: ${target}`);
  }
  if (!Array.isArray(entry.profiles) || entry.profiles.length === 0) {
    fail(`Target has no profiles: ${target}`);
  }
  for (const profile of entry.profiles) {
    if (!Object.hasOwn(config.profiles, profile)) {
      fail(`Unknown profile ${profile} for ${target}`);
    }
  }
  if (entry.regression_candidate) {
    const candidate = entry.regression_candidate;
    if (!/^[0-9a-f]{40}$/.test(candidate.sha)) {
      fail(`Invalid regression SHA: ${target}`);
    }
    if (!entry.profiles.includes(candidate.profile)) {
      fail(`Regression profile is not authorized: ${target}`);
    }
    if (config.profiles[candidate.profile].family !== 'python') {
      fail(`Only isolated Python regression candidates are supported: ${target}`);
    }
    if (!Array.isArray(candidate.python_versions) ||
        candidate.python_versions.length === 0 ||
        new Set(candidate.python_versions).size !== candidate.python_versions.length ||
        candidate.python_versions.some((version) => !['3.11', '3.12'].includes(version))) {
      fail(`Invalid Python regression matrix: ${target}`);
    }
  }
}

if (!workflow.includes('permissions: {}')) {
  fail('The workflow must default to zero permissions');
}
if (/\$\{\{\s*secrets\./.test(workflow)) {
  fail('The relay workflow may not reference the GitHub secrets context');
}
if (fs.existsSync('receipts')) {
  fail('Receipt data must not be tracked on the trusted branch');
}
if (!workflow.includes('ref: receipts')) {
  fail('The receipt job must check out the receipts branch');
}
if (!workflow.includes('git -C ledger push origin HEAD:receipts')) {
  fail('Durable receipts must be pushed only to the receipts branch');
}
if (workflow.includes('git push origin HEAD:main') ||
    workflow.includes('git -C ledger push origin HEAD:main')) {
  fail('The receipt job must never push to main');
}

const actionUses = workflow
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('uses: actions/'));
for (const line of actionUses) {
  if (!/@[0-9a-f]{40}(?:\s|$)/.test(line)) {
    fail(`GitHub-owned action is not pinned to a full SHA: ${line}`);
  }
}

console.log(
  `verified ${Object.keys(config.targets).length} targets, ` +
    `${Object.keys(config.profiles).length} profiles, zero secrets, ` +
    'pinned actions, exact SHAs, and isolated receipt writes',
);
