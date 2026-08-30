import fs from 'node:fs';

const fail = (message) => {
  throw new Error(message);
};
const config = JSON.parse(fs.readFileSync('config/targets.json', 'utf8'));
const workflow = fs.readFileSync(
  '.github/workflows/relay-process-environment.yml',
  'utf8',
);

if (config.schema !== 'organvm.relay-targets.v2') {
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
if (!Array.isArray(config.policy?.allowed_secrets) ||
    config.policy.allowed_secrets.length !== 0) {
  fail('Target jobs may not receive secrets');
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
}

if (!workflow.includes('permissions: {}')) {
  fail('The workflow must default to zero permissions');
}
if (workflow.includes('secrets.')) {
  fail('The relay workflow may not reference secrets');
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
  `verified ${Object.keys(config.targets).length} target(s), zero secrets, ` +
    'exact-SHA policy, pinned actions, and isolated receipt writes',
);
