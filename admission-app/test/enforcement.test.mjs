import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dedicatedAppId = 1234567;
const renderScript = fileURLToPath(new URL('../enforcement/render-config.mjs', import.meta.url));
const readbackScript = fileURLToPath(new URL('../enforcement/verify-readback.mjs', import.meta.url));

function render(id) {
  return spawnSync(process.execPath, [renderScript, String(id)], { encoding: 'utf8' });
}

function fixture() {
  return {
    required_status_checks: {
      strict: true,
      contexts: ['Relay admission / trusted'],
      checks: [{ context: 'Relay admission / trusted', app_id: dedicatedAppId }],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_last_push_approval: true,
      require_code_owner_reviews: true,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    required_conversation_resolution: { enabled: true },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

function verify(value, id = dedicatedAppId) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-enforcement-'));
  const filename = join(directory, 'readback.json');
  try {
    writeFileSync(filename, JSON.stringify(value));
    return spawnSync(process.execPath, [readbackScript, filename, String(id)], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('renders a typed, strict configuration bound only to the dedicated App', () => {
  const result = render(dedicatedAppId);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.required_status_checks, {
    strict: true,
    contexts: [],
    checks: [{ context: 'Relay admission / trusted', app_id: dedicatedAppId }],
  });
  assert.equal(value.enforce_admins, true);
  assert.equal(value.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(value.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.equal(value.required_pull_request_reviews.require_last_push_approval, true);
  assert.equal(value.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(value.allow_force_pushes, false);
  assert.equal(value.allow_deletions, false);
});

for (const id of [0, -1, '9007199254740992', 15368]) {
  test(`rendering and readback reject prohibited App ID ${id}`, () => {
    const value = fixture();
    value.required_status_checks.checks[0].app_id = Number(id);
    for (const result of [render(id), verify(value, id)]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, id === 15368 ? /shared producer/ : /Usage:/);
    }
  });
}

test('readback accepts the complete enforced configuration', () => {
  const result = verify(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /readback matches expected controls/);
});

for (const [name, mutate] of [
  ['shared check producer', value => { value.required_status_checks.checks[0].app_id = 15368; }],
  ['wrong dedicated producer', value => { value.required_status_checks.checks[0].app_id = dedicatedAppId + 1; }],
  ['unbound producer', value => { delete value.required_status_checks.checks[0].app_id; }],
  ['non-strict checks', value => { value.required_status_checks.strict = false; }],
  ['administrator exemption', value => { value.enforce_admins.enabled = false; }],
  ['review bypass for users', value => { value.required_pull_request_reviews.bypass_pull_request_allowances.users = [{ id: 10 }]; }],
  ['review bypass for teams', value => { value.required_pull_request_reviews.bypass_pull_request_allowances.teams = [{ id: 20 }]; }],
  ['review bypass for apps', value => { value.required_pull_request_reviews.bypass_pull_request_allowances.apps = [{ id: 30 }]; }],
  ['no required independent approval', value => { value.required_pull_request_reviews.required_approving_review_count = 0; }],
  ['stale reviews retained', value => { value.required_pull_request_reviews.dismiss_stale_reviews = false; }],
  ['last-push approval waived', value => { value.required_pull_request_reviews.require_last_push_approval = false; }],
]) {
  test(`readback rejects ${name}`, () => {
    const value = fixture();
    mutate(value);
    const result = verify(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AssertionError/);
  });
}
