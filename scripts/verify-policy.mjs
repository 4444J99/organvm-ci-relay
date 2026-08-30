import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => {
  throw new Error(message);
};
const config = JSON.parse(fs.readFileSync('config/targets.json', 'utf8'));
const workflowDirectory = path.join('.github', 'workflows');
const expectedWorkflowFiles = [
  'relay-policy.yml',
  'relay-process-environment.yml',
];
const workflowFiles = fs.readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
if (JSON.stringify(workflowFiles) !== JSON.stringify(expectedWorkflowFiles)) {
  fail(`Unexpected workflow set: ${workflowFiles.join(', ')}`);
}
const workflows = Object.fromEntries(
  workflowFiles.map((file) => [
    file,
    fs.readFileSync(path.join(workflowDirectory, file), 'utf8'),
  ]),
);
const workflow = workflows['relay-process-environment.yml'];
const policyWorkflow = workflows['relay-policy.yml'];

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
  const executableProfilePaths = [shellProfilePath];
  if (profile.family === 'process-environment') {
    const windowsProfilePath = path.join('profiles', `${name}.ps1`);
    if (!fs.existsSync(windowsProfilePath)) {
      fail(`Missing Windows relay profile: ${name}`);
    }
    executableProfilePaths.push(windowsProfilePath);
  }
  for (const executableProfilePath of executableProfilePaths) {
    const source = fs.readFileSync(executableProfilePath, 'utf8');
    const gitDependencies = source.match(
      /git\+(?:https?|ssh|git|file):\/\/[^\s'"]+/gi,
    ) ?? [];
    for (const dependency of gitDependencies) {
      if (!dependency.startsWith('git+https://') ||
          !/\.git@[0-9a-f]{40}(?:[#?][^\s'"]*)?$/.test(dependency)) {
        fail(`Unpinned or unsupported Git dependency in ${executableProfilePath}`);
      }
    }
    if (/\bgit\s+(?:clone|fetch|pull|submodule)\b/i.test(source)) {
      fail(`Raw Git network command in ${executableProfilePath}`);
    }
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

if (!/^permissions:\s*\{\}\s*$/m.test(workflow)) {
  fail('The workflow must default to zero permissions');
}
for (const [file, source] of Object.entries(workflows)) {
  const expressions = source.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
  if (expressions.some((expression) => /\bsecrets\b/.test(expression))) {
    fail(`Workflow may not reference the GitHub secrets context: ${file}`);
  }
  if (/^\s*permissions:\s*write-all\s*$/m.test(source)) {
    fail(`Workflow may not grant write-all permissions: ${file}`);
  }
}
if (fs.existsSync('receipts')) {
  fail('Receipt data must not be tracked on the trusted branch');
}
if (!workflow.split('\n').some((line) => line.trim() === 'ref: receipts')) {
  fail('The receipt job must check out the receipts branch');
}
const pushCommands = workflow.split('\n')
  .map((line) => line.trim())
  .filter((line) => !line.startsWith('#') &&
    /\bgit(?:\s+-C\s+\S+)?\s+push\b/.test(line));
if (pushCommands.length !== 1 ||
    pushCommands[0] !== 'git -C ledger push origin HEAD:receipts') {
  fail('The receipt push must be the only Git push command');
}
const writePermissions = [...workflow.matchAll(
  /^\s+([a-z-]+):\s*write\s*(?:#.*)?$/gm,
)];
if (writePermissions.length !== 1 || writePermissions[0][1] !== 'contents') {
  fail('Only the isolated receipt job may receive one contents: write grant');
}
if (!/^  receipt:\s*$[\s\S]*?^    permissions:\s*$\n^      contents:\s*write\s*$/m
    .test(workflow)) {
  fail('The contents: write grant must belong to the receipt job');
}
const requiredExecutableLines = [
  '- ".github/workflows/relay-policy.yml"',
  '- "scripts/**"',
  'relay-${{ github.event_name == \'push\' && github.sha || format(\'{0}-{1}-{2}\', inputs.target, inputs.profile, inputs.sha) }}',
  'cancel-in-progress: ${{ github.event_name != \'push\' }}',
  '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]',
  'fetch --no-tags --depth=1 origin "$revision"',
  '[[ "$(git -C "$directory" rev-parse HEAD)" == "$revision" ]]',
  'relative_receipt="${receipt_file#ledger/}"',
  'sha256sum "$relative_receipt"',
  'sha256sum -c "$relative_receipt.sha256"',
];
const executableLines = new Set(
  workflow.split('\n').map((line) => line.trim()),
);
for (const line of requiredExecutableLines) {
  if (!executableLines.has(line)) {
    fail(`Missing trust-boundary command: ${line}`);
  }
}
if (workflow.includes('sha256sum "$receipt_file" > "$receipt_file.sha256"')) {
  fail('Receipt checksums must record branch-relative paths');
}

const policyRunLines = policyWorkflow.split('\n')
  .map((line) => line.trim())
  .filter((line) => /^-\s*run:/.test(line));
const expectedPolicyRunLines = [
  '- run: node scripts/verify-policy.mjs',
  '- run: node scripts/test-policy.mjs',
];
if (JSON.stringify(policyRunLines) !== JSON.stringify(expectedPolicyRunLines)) {
  fail('Relay policy workflow must run only the verifier and its regressions');
}

for (const [file, source] of Object.entries(workflows)) {
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!/^-?\s*uses:/.test(line)) continue;
    const match = line.match(
      /^-?\s*uses:\s*["']?([^"'\s#]+)["']?(?:\s+#.*)?$/,
    );
    if (!match) fail(`Malformed action reference in ${file}: ${line}`);
    const action = match[1];
    if (!action.startsWith('./') && !/@[0-9a-f]{40}$/.test(action)) {
      fail(`External action is not pinned to a full SHA in ${file}: ${action}`);
    }
  }
}

console.log(
  `verified ${Object.keys(config.targets).length} targets, ` +
    `${Object.keys(config.profiles).length} profiles, zero secrets, ` +
    'pinned actions, exact SHAs, and isolated receipt writes',
);
