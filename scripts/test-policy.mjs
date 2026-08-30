import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = process.cwd();
const fixtureRoots = [];

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'organvm-relay-policy-'));
  fixtureRoots.push(root);
  for (const directory of ['.github', 'config', 'profiles']) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(root, directory), {
      recursive: true,
    });
  }
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(
    path.join(sourceRoot, 'scripts', 'verify-policy.mjs'),
    path.join(root, 'scripts', 'verify-policy.mjs'),
  );
  return root;
};

const runVerifier = (root) => spawnSync(
  process.execPath,
  ['scripts/verify-policy.mjs'],
  { cwd: root, encoding: 'utf8' },
);

const replace = (root, relativePath, from, to) => {
  const file = path.join(root, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(from), `fixture marker missing in ${relativePath}`);
  fs.writeFileSync(file, source.replace(from, to));
};

const expectRejected = (name, mutate) => {
  const root = createFixture();
  mutate(root);
  const result = runVerifier(root);
  assert.notEqual(
    result.status,
    0,
    `${name} unexpectedly passed\n${result.stdout}\n${result.stderr}`,
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
  });

  expectRejected('dotted secrets context', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'jobs:\n',
      'env:\n  LEAK: ${{ secrets.TOKEN }}\njobs:\n',
    );
  });

  expectRejected('top-level write permission', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'permissions: {}',
      'permissions:\n  contents: write',
    );
  });

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
  });

  expectRejected('floating external action', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/checkout@main',
    );
  });

  expectRejected('quoted floating external action', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'uses: "actions/checkout@main" # floating',
    );
  });

  expectRejected('uppercase action SHA', (root) => {
    replace(
      root,
      '.github/workflows/relay-policy.yml',
      '3d3c42e5aac5ba805825da76410c181273ba90b1',
      '3D3C42E5AAC5BA805825DA76410C181273BA90B1',
    );
  });

  expectRejected('additional workflow', (root) => {
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'unreviewed.yml'),
      'name: unreviewed\non: push\njobs: {}\n',
    );
  });

  expectRejected('main-branch receipt push', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'git -C ledger push origin HEAD:receipts',
      'git -C ledger push origin HEAD:refs/heads/main',
    );
  });

  expectRejected('receipt checkout changed behind a comment', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'ref: receipts',
      'ref: main # ref: receipts',
    );
  });

  expectRejected('missing branch-relative checksum verification', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      'sha256sum -c "$relative_receipt.sha256"',
      'true # checksum verification removed',
    );
  });

  expectRejected('cancellable trust-root push', (root) => {
    replace(
      root,
      '.github/workflows/relay-process-environment.yml',
      "cancel-in-progress: ${{ github.event_name != 'push' }}",
      'cancel-in-progress: true',
    );
  });

  console.log('verified 12 fail-closed relay policy regressions');
} finally {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
