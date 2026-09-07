/** Target-registry admission unit tests, not hosted relay or provider execution.
 * Runs the actual verifier section in isolation because the full CLI additionally
 * requires workflow/profile files and a trusted-base filesystem snapshot.
 * Run: node --test scripts/test-registry-boundaries.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'verify-policy.mjs'), 'utf8');
const workflowSource = fs.readFileSync(
  path.join(here, '..', '.github', 'workflows', 'relay-process-environment.yml'),
  'utf8',
);
const startMarker = 'const targetPattern =';
const endMarker = 'const canary = config.canary;';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert(start >= 0 && end > start, 'verifier target-admission section must exist');
assert.equal(source.indexOf(startMarker, start + 1), -1, 'target admission must have one owner');
const targetAdmission = source.slice(start, end);
const workflowIncludeMarker = '          const include = [];';
const workflowInclude = workflowSource.indexOf(workflowIncludeMarker);
const workflowStart = workflowSource.lastIndexOf(
  "          const fs = require('fs');",
  workflowInclude,
);
const workflowEnd = workflowSource.indexOf('\n          NODE', workflowInclude);
assert(
  workflowStart >= 0 && workflowInclude > workflowStart && workflowEnd > workflowInclude,
  'embedded workflow matrix builder must exist',
);
const workflowMatrixBuilder = workflowSource.slice(workflowStart, workflowEnd)
  .replace(/^ {10}/gmu, '');

function registry(count = 1) {
  return {
    profiles: {
      python: { family: 'python', runtime: { python_versions: ['3.12.14'] } },
      posix: { family: 'process-environment' },
    },
    targets: Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `synthetic/repo-${index}`,
      {
        stable_repository_id: String(index + 1),
        visibility: 'public',
        profiles: ['python'],
        regression_candidate: { profile: 'python', sha: 'a'.repeat(40) },
      },
    ])),
  };
}

function admit(config) {
  return runInNewContext(`${targetAdmission}\nregressionJobCount;`, {
    config: structuredClone(config),
    fail(message) { throw new Error(message); },
  }, { timeout: 1000 });
}

function first(config) {
  return config.targets[Object.keys(config.targets)[0]];
}

function buildWorkflowMatrix(config) {
  let output = '';
  runInNewContext(workflowMatrixBuilder, {
    require(specifier) {
      assert.equal(specifier, 'fs');
      return {
        readFileSync(file) {
          assert.equal(file, 'config/targets.json');
          return JSON.stringify(config);
        },
        appendFileSync(file, value) {
          assert.equal(file, 'matrix-output');
          output += value;
        },
      };
    },
    process: { env: { GITHUB_OUTPUT: 'matrix-output' } },
  }, { timeout: 1000 });
  assert.match(output, /^matrix=/u);
  return JSON.parse(output.slice('matrix='.length)).include;
}

const currentWorkflowRegistry = () => JSON.parse(fs.readFileSync(
  path.join(here, '..', 'config', 'targets.json'),
  'utf8',
));

test('one exact public candidate admits one job', () => {
  assert.equal(admit(registry()), 1);
});

test('runtime versions determine the real matrix cardinality', () => {
  const config = registry(2);
  config.profiles.python.runtime.python_versions = ['3.11.16', '3.12.14'];
  assert.equal(admit(config), 4);
});

test('an omitted optional candidate is allowed when another target supplies a job', () => {
  const config = registry(2);
  delete first(config).regression_candidate;
  assert.equal(admit(config), 1);
});

for (const value of [null, false, 0, '']) {
  test(`explicit ${JSON.stringify(value)} candidate cannot masquerade as omission`, () => {
    const config = registry(2);
    first(config).regression_candidate = value;
    assert.throws(() => admit(config), /Invalid regression candidate record/);
  });
}

for (const value of [true, [], {}, 'candidate', 1]) {
  test(`malformed ${JSON.stringify(value)} candidate is rejected`, () => {
    const config = registry(2);
    first(config).regression_candidate = value;
    assert.throws(() => admit(config), /Invalid regression candidate record/);
  });
}

test('removing every candidate fails before runtime matrix creation', () => {
  const config = registry(2);
  for (const entry of Object.values(config.targets)) delete entry.regression_candidate;
  assert.throws(() => admit(config), /Regression matrix must contain at least one job/);
});

test('embedded workflow builds the current nonempty regression matrix', () => {
  assert(buildWorkflowMatrix(currentWorkflowRegistry()).length > 0);
});

for (const value of [null, false, 0, '']) {
  test(`embedded workflow rejects explicit ${JSON.stringify(value)} candidate`, () => {
    const config = currentWorkflowRegistry();
    first(config).regression_candidate = value;
    assert.throws(
      () => buildWorkflowMatrix(config),
      /Invalid regression candidate record/,
    );
  });
}

test('embedded workflow rejects an empty regression matrix', () => {
  const config = currentWorkflowRegistry();
  for (const entry of Object.values(config.targets)) delete entry.regression_candidate;
  assert.throws(() => buildWorkflowMatrix(config), /Regression matrix is empty/);
});

test('the exact matrix upper bound is admitted', () => {
  assert.equal(admit(registry(32)), 32);
});

test('matrix upper bound plus one is rejected', () => {
  assert.throws(() => admit(registry(33)), /at most 32 jobs/);
});

test('runtime expansion cannot silently exceed the matrix bound', () => {
  const config = registry(17);
  config.profiles.python.runtime.python_versions = ['3.11.16', '3.12.14'];
  assert.throws(() => admit(config), /at most 32 jobs/);
});

for (const [label, mutate, expected] of [
  ['private source', (c) => { first(c).visibility = 'private'; }, /Non-public target/],
  ['floating SHA', (c) => { first(c).regression_candidate.sha = 'main'; }, /Invalid regression SHA/],
  ['uppercase SHA', (c) => { first(c).regression_candidate.sha = 'A'.repeat(40); }, /Invalid regression SHA/],
  ['unknown profile', (c) => { first(c).profiles = ['unknown']; }, /Unknown profile/],
  ['unauthorized regression profile', (c) => { first(c).regression_candidate.profile = 'posix'; }, /not authorized/],
  ['non-Python regression', (c) => { first(c).profiles.push('posix'); first(c).regression_candidate.profile = 'posix'; }, /Only isolated Python/],
  ['duplicate profile', (c) => { first(c).profiles.push('python'); }, /Invalid target profile list/],
  ['duplicate stable ID', (c) => { c.targets['synthetic/repo-1'].stable_repository_id = '1'; }, /Duplicate stable repository ID/],
  ['unknown target field', (c) => { first(c).authority = 'unbounded'; }, /Unexpected target record keys/],
  ['invalid stable ID', (c) => { first(c).stable_repository_id = '0'; }, /Invalid stable repository ID/],
  ['empty target registry', (c) => { c.targets = {}; }, /non-empty object/],
]) {
  test(`${label} fails closed`, () => {
    const config = registry(2);
    mutate(config);
    assert.throws(() => admit(config), expected);
  });
}
