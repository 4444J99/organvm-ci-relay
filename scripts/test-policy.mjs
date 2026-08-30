import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

const runVerifier = (root) => spawnSync(
  process.execPath,
  [
    path.join(sourceRoot, 'scripts', 'verify-policy.mjs'),
    '--candidate-root',
    root,
    '--base-root',
    sourceRoot,
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

try {
  const baseline = runVerifier(createFixture());
  assert.equal(
    baseline.status,
    0,
    `baseline failed\n${baseline.stdout}\n${baseline.stderr}`,
  );

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
  }, /Frozen executable trust root changed: profiles\/python-ruff-pytest-v1\.sh/u);

  expectRejected('candidate cannot edit the relay launcher', (root) => {
    fs.appendFileSync(path.join(root, 'relay'), '\n# candidate-only launcher edit\n');
  }, /Frozen executable trust root changed: relay/u);

  expectRejected('candidate cannot add a trusted profile', (root) => {
    fs.writeFileSync(path.join(root, 'profiles', 'untrusted.sh'), '#!/usr/bin/env bash\n');
  }, /Frozen executable trust root changed: profiles/u);

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
      `${acceptanceCount} dynamic policy acceptance cases`,
  );
} finally {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
