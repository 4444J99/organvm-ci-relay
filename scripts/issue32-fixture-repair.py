#!/usr/bin/env python3
"""One-off diagnostic repair; publishes only PR36's pinned unprotected work branch."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = '4444J99/organvm-ci-relay'
REPOSITORY_ID = 1350979676
BRANCH = 'chore/laurea-regression-34-20260922'
EXPECTED_HEAD = 'b12ca96b9c2cc7b478ad27ce1268de9694e75b59'
SOURCE_BLOB = 'cf87f8c091131e91442b573bba86b1f041e50c39'
SOURCE_PATH = 'scripts/test-policy.mjs'


def blob_id(data: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def repaired(data: bytes) -> bytes:
    if blob_id(data) != SOURCE_BLOB:
        raise RuntimeError('Unexpected source blob; refuse stale transformation')
    source = data.decode('utf-8')
    marker = 'const sourceRoot = fs.realpathSync(path.resolve(invocationRoot, requestedBaseRoot));\n'
    if source.count(marker) != 1:
        raise RuntimeError('Expected one fixture-root definition')
    helper = r'''
// Resolve fixture identities independently of their current repository location.
const sourceRegistry = JSON.parse(fs.readFileSync(
  path.join(sourceRoot, 'config', 'targets.json'), 'utf8',
));
const fixtureRepository = (stableId) => {
  const matches = Object.entries(sourceRegistry.targets).filter(
    ([, target]) => String(target.stable_repository_id) === stableId,
  );
  assert.equal(matches.length, 1, `fixture needs exactly one repository ID ${stableId}`);
  return matches[0][0];
};
const laureaRepository = fixtureRepository('1289397231');
const learningRepository = fixtureRepository('1155240211');
const escapeFixtureRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
'''
    source = source.replace(marker, marker + helper)
    replacements = {
        "registry.targets['organvm/laurea']": 'registry.targets[laureaRepository]',
        "registry.targets['organvm/learning-resources']": 'registry.targets[learningRepository]',
        "registry.canary.target = 'organvm/learning-resources';": 'registry.canary.target = learningRepository;',
        "registry.targets['ORGANVM/LAUREA']": 'registry.targets[laureaRepository.toUpperCase()]',
        r'/Invalid regression candidate record: organvm\/laurea/u': "new RegExp(`Invalid regression candidate record: ${escapeFixtureRegex(laureaRepository)}`, 'u')",
        r'/Invalid stable repository ID: organvm\/laurea/u': "new RegExp(`Invalid stable repository ID: ${escapeFixtureRegex(laureaRepository)}`, 'u')",
        r'/Target names must be unique lowercase identities: ORGANVM\/LAUREA/u': "new RegExp(`Target names must be unique lowercase identities: ${escapeFixtureRegex(laureaRepository.toUpperCase())}`, 'u')",
    }
    for before, after in replacements.items():
        if before not in source:
            raise RuntimeError('Expected fixture marker is absent')
        source = source.replace(before, after)
    if any(marker in source for marker in ('organvm/', 'organvm\\/', 'ORGANVM/', 'ORGANVM\\/')):
        raise RuntimeError('Additional hardcoded fixture location needs inspection')
    marker = '  console.log(\n    `verified ${regressionCount} fail-closed relay policy regressions and ` +'
    if source.count(marker) != 1:
        raise RuntimeError('Expected one final regression-count report')
    regression = '''  expectAccepted('dynamic stable-ID-preserving repository relocation', (root) => {
    mutateRegistry(root, (registry) => {
      const relocated = 'example/relocated-learning-resources';
      assert.equal(registry.targets[relocated], undefined);
      const existing = registry.targets[learningRepository];
      assert.equal(String(existing.stable_repository_id), '1155240211');
      registry.targets[relocated] = existing;
      delete registry.targets[learningRepository];
      if (registry.canary.target === learningRepository) registry.canary.target = relocated;
    });
  });

'''
    return source.replace(marker, regression + marker).encode('utf-8')


def api(method: str, path: str, data=None):
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        raise RuntimeError('Repository-scoped workflow token absent')
    request = urllib.request.Request(
        'https://api.github.com/repos/' + REPOSITORY + path,
        method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'GitHub {method} request rejected with HTTP {exc.code}') from None


def publish() -> None:
    # No candidate code, shell commands, artifacts or candidate-provided outputs are executed.
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise RuntimeError('Wrong workflow repository')
    repository = api('GET', '')
    if repository['id'] != REPOSITORY_ID or repository['private'] or repository['archived']:
        raise RuntimeError('Repository identity/lifecycle changed')
    if repository['default_branch'] == BRANCH:
        raise RuntimeError('Never publish to the default branch')
    branch = api('GET', '/branches/' + urllib.parse.quote(BRANCH, safe=''))
    if branch['protected'] is not False or branch['commit']['sha'] != EXPECTED_HEAD:
        raise RuntimeError('Work branch moved or became protected')
    pr = api('GET', '/pulls/36')
    if pr['state'] != 'open' or pr.get('merged') or pr['head']['sha'] != EXPECTED_HEAD or pr['head']['ref'] != BRANCH:
        raise RuntimeError('Expected open PR head changed')
    if pr['head']['repo']['id'] != REPOSITORY_ID:
        raise RuntimeError('Foreign PR head repository')
    parent = api('GET', '/git/commits/' + EXPECTED_HEAD)
    content = api('GET', '/contents/' + SOURCE_PATH + '?ref=' + EXPECTED_HEAD)
    original = base64.b64decode(content['content'])
    output = repaired(original)
    blob = api('POST', '/git/blobs', {'content': output.decode(), 'encoding': 'utf-8'})
    if blob['sha'] != blob_id(output):
        raise RuntimeError('Created blob did not match deterministic repair')
    tree = api('POST', '/git/trees', {'base_tree': parent['tree']['sha'], 'tree': [
        {'path': SOURCE_PATH, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']},
    ]})
    commit = api('POST', '/git/commits', {
        'message': 'fix(relay): bind policy fixtures to stable repository identities\n\nPreserve rejection assertions across owner/name transfers, and add a positive stable-ID relocation case. Full current and historical namespace source suites verified before publication. Only test-policy.mjs changes; no verifier or permissions weakened. Refs #36, #34, #32.',
        'tree': tree['sha'], 'parents': [EXPECTED_HEAD],
    })
    readback = api('GET', '/git/commits/' + commit['sha'])
    if readback['tree']['sha'] != tree['sha'] or [p['sha'] for p in readback['parents']] != [EXPECTED_HEAD]:
        raise RuntimeError('Created commit readback mismatch')
    branch = api('GET', '/branches/' + urllib.parse.quote(BRANCH, safe=''))
    if branch['protected'] is not False or branch['commit']['sha'] != EXPECTED_HEAD:
        raise RuntimeError('Work branch changed before publication')
    api('PATCH', '/git/refs/heads/' + BRANCH, {'sha': commit['sha'], 'force': False})
    landed = api('GET', '/git/ref/heads/' + BRANCH)
    if landed['object']['sha'] != commit['sha']:
        raise RuntimeError('Published branch changed before readback')
    print(json.dumps({'branch': BRANCH, 'head': commit['sha'], 'tree': tree['sha'],
                      'parent': EXPECTED_HEAD, 'test_policy_blob': blob['sha'],
                      'force': False, 'default_branch_mutation': False}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'apply':
        path = Path(sys.argv[2])
        output = repaired(path.read_bytes())
        path.write_bytes(output)
        print('REPAIRED_TEST_POLICY_BLOB=' + blob_id(output))
    elif sys.argv[1:] == ['publish']:
        publish()
    else:
        raise SystemExit('Usage: issue32-fixture-repair.py apply FILE | publish')
