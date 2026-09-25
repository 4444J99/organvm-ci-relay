#!/usr/bin/env python3
"""Bounded static-executable remediation for the pinned PR38 source only."""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = '4444J99/organvm-ci-relay'
BRANCH = 'fix/32-malformed-publication-readbacks'
HEAD = '1aae0c3f36328dff5629f1c7a9f82e68862c9bb5'
SOURCES = {
    'scripts/connector_publish.py': 'e548b228eeb2fdab269e60d3f26e6faf88735dd5',
    'scripts/test_connector_publish_readbacks.py': 'c8a5f089aeb621de9fc1ad396e8ff1ae0f725df0',
}


def oid(data):
    """Compute the exact Git blob identity without running repository code."""
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def transform(path, data):
    """Apply only the reviewed literal substitutions and boundary tests."""
    if oid(data) != SOURCES[path]:
        raise RuntimeError('Source changed before remediation')
    text = data.decode()
    if path.endswith('/connector_publish.py'):
        replacements = (
            ('command = ["git", "--no-replace-objects"', 'command = ["--no-replace-objects"', 1),
            ('[*command,', '["git", *command,', 3),
            ('check=False, capture_output=True, timeout=30', 'shell=False, check=False, capture_output=True, timeout=30', 3),
        )
        for before, after, count in replacements:
            if text.count(before) != count:
                raise RuntimeError('Unexpected subprocess call structure')
            text = text.replace(before, after)
        parsed = ast.parse(text)
        calls = [n for n in ast.walk(parsed) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == 'subprocess' and n.func.attr == 'run']
        if len(calls) != 3 or any(not isinstance(n.args[0], ast.List) or not isinstance(n.args[0].elts[0], ast.Constant) or n.args[0].elts[0].value != 'git' or not any(k.arg == 'shell' and isinstance(k.value, ast.Constant) and k.value.value is False for k in n.keywords) for n in calls):
            raise RuntimeError('Fixed executable and explicit no-shell contract not established')
    else:
        marker = '\n\nif __name__ == "__main__":\n'
        if text.count(marker) != 1:
            raise RuntimeError('Unexpected test entry point')
        tests = '''

class GitInvocationBoundaryTests(unittest.TestCase):
    """Keep the executable and shell policy statically visible at every subprocess call."""

    def test_every_subprocess_uses_literal_git_and_no_shell(self):
        """Reject indirect executable selection or shell-enabled subprocess calls."""
        import ast
        from pathlib import Path
        tree = ast.parse(Path(bridge.__file__).read_text())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute)
                 and isinstance(n.func.value, ast.Name)
                 and n.func.value.id == 'subprocess' and n.func.attr == 'run']
        self.assertEqual(len(calls), 3)
        for call in calls:
            self.assertIsInstance(call.args[0], ast.List)
            self.assertIsInstance(call.args[0].elts[0], ast.Constant)
            self.assertEqual(call.args[0].elts[0].value, 'git')
            shell = [k.value for k in call.keywords if k.arg == 'shell']
            self.assertEqual(len(shell), 1)
            self.assertIsInstance(shell[0], ast.Constant)
            self.assertIs(shell[0].value, False)

    def test_status_filter_scan_and_index_probe_keep_argument_boundaries(self):
        """Pass shell metacharacters as literal argv through all three inspection calls."""
        from pathlib import Path
        import subprocess
        from unittest.mock import patch
        root = Path('/tmp/checkout;not-a-command')
        argument = 'literal;$(not-a-command)'
        results = [subprocess.CompletedProcess([], 1, b'', b''),
                   subprocess.CompletedProcess([], 0, b'', b''),
                   subprocess.CompletedProcess([], 0, b'clean', b'')]
        with patch.object(bridge.subprocess, 'run', side_effect=results) as run:
            self.assertEqual(bridge.git(root, 'status', '--porcelain=v1', '--', argument), b'clean')
        self.assertEqual(run.call_count, 3)
        for call in run.call_args_list:
            argv = call.args[0]
            self.assertIsInstance(argv, list)
            self.assertEqual(argv[0], 'git')
            self.assertEqual(argv[argv.index('-C') + 1], str(root))
            self.assertIs(call.kwargs['shell'], False)
        self.assertEqual(run.call_args_list[-1].args[0][-1], argument)
'''
        text = text.replace(marker, tests + marker)
    result = text.encode()
    compile(result, path, 'exec')
    return result


def api(method, path, data=None):
    """Use only the existing repository-scoped workflow credential, without logging it."""
    token = os.environ.get('GITHUB_TOKEN')
    if not token or os.environ.get('GITHUB_REPOSITORY') != REPO:
        raise RuntimeError('Repository-scoped workflow identity unavailable')
    req = urllib.request.Request('https://api.github.com/repos/' + REPO + path,
        method=method, data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'GitHub request rejected: HTTP {exc.code}') from None


def preflight():
    """Refuse closed, moved, protected, default or foreign publication targets."""
    repo = api('GET', '')
    branch = api('GET', '/branches/' + urllib.parse.quote(BRANCH, safe=''))
    pr = api('GET', '/pulls/38')
    if repo['id'] != 1350979676 or repo['private'] or repo['archived'] or repo['default_branch'] == BRANCH:
        raise RuntimeError('Repository identity changed')
    if branch['protected'] is not False or branch['commit']['sha'] != HEAD:
        raise RuntimeError('Branch moved or became protected')
    if pr['state'] != 'open' or pr.get('merged') or pr['head']['sha'] != HEAD or pr['head']['ref'] != BRANCH or pr['head']['repo']['id'] != 1350979676:
        raise RuntimeError('PR identity changed')


def publish():
    """Recreate tested bytes without executing candidate code and advance only the work branch."""
    preflight()
    parent = api('GET', '/git/commits/' + HEAD)
    elements = []
    for path in SOURCES:
        original = api('GET', '/contents/' + path + '?ref=' + HEAD)
        output = transform(path, base64.b64decode(original['content']))
        blob = api('POST', '/git/blobs', {'content': output.decode(), 'encoding': 'utf-8'})
        if blob['sha'] != oid(output):
            raise RuntimeError('Blob readback mismatch')
        elements.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    tree = api('POST', '/git/trees', {'base_tree': parent['tree']['sha'], 'tree': elements})
    commit = api('POST', '/git/commits', {'message': 'fix(publish): make fixed Git executable and no-shell policy explicit\n\nRetain exact argument-list semantics and filter protections while making all three Git invocations statically recognizable. Add literal-executable/no-shell and argument-boundary regressions. All 43 publisher tests and relay suites verified before non-forced branch publication. Refs #38, #32.', 'tree': tree['sha'], 'parents': [HEAD]})
    readback = api('GET', '/git/commits/' + commit['sha'])
    if readback['tree']['sha'] != tree['sha'] or [p['sha'] for p in readback['parents']] != [HEAD]:
        raise RuntimeError('Commit readback mismatch')
    preflight()
    api('PATCH', '/git/refs/heads/' + BRANCH, {'sha': commit['sha'], 'force': False})
    if api('GET', '/git/ref/heads/' + BRANCH)['object']['sha'] != commit['sha']:
        raise RuntimeError('Published ref readback mismatch')
    print(json.dumps({'head': commit['sha'], 'tree': tree['sha'], 'parent': HEAD, 'files': elements, 'force': False}))


if __name__ == '__main__':
    if sys.argv[1:] == ['apply']:
        for name in SOURCES:
            path = Path(name)
            output = transform(name, path.read_bytes())
            path.write_bytes(output)
            print(json.dumps({'path': name, 'blob': oid(output)}))
    elif sys.argv[1:] == ['publish']:
        publish()
    else:
        raise SystemExit('Use apply or publish')
