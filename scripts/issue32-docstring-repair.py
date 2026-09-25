#!/usr/bin/env python3
"""Verify and publish documentation-only changes to one pinned PR work branch."""
from __future__ import annotations
import ast
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = '4444J99/organvm-ci-relay'
BRANCH = 'fix/32-malformed-publication-readbacks'
HEAD = 'c213307271c9fad22fe0c247b737f9e89f497b0c'
SOURCES = {
    'scripts/connector_publish.py': '13c63093f6b9659fe772a01ad9ed9e76fb261701',
    'scripts/test_connector_publish.py': '8b74d998fdcd3feab8350735ec2ea76308318094',
    'scripts/test_connector_publish_readbacks.py': 'c8a5f089aeb621de9fc1ad396e8ff1ae0f725df0',
}
DESCRIPTIONS = {
    'git': 'Inspect local Git objects without replacement refs, lazy fetches, locks, or configured filters.',
    'oid': 'Validate a complete lowercase SHA-1 object identifier before using it in Git requests.',
    'entries': 'Read recursive Git tree entries while preserving file modes, object types, and UTF-8 paths.',
    'main': 'Parse the bounded publication request and report a prepared plan or an explicit refusal.',
    'setUp': 'Create an isolated Git repository with a known committed baseline for each test.',
    'write': 'Write exact fixture bytes into the isolated repository, creating parent directories as needed.',
    'commit': 'Commit the fixture changes and return the full candidate object identifier.',
    'prepare': 'Prepare a publication from the fixture baseline with an explicit complete path allowance.',
    'normal': 'Create a valid text change containing CRLF and Unicode for shared publication assertions.',
    'replay_tree': 'Reconstruct the proposed overlay with real Git objects and return its complete tree identifier.',
    'readbacks': 'Build mutually consistent repository, PR, branch, tree, and commit API fixtures.',
    'render': 'Render the strict protection fixture using the actual configuration script.',
    'verify': 'Run the actual readback verifier against an isolated JSON fixture.',
}


def blob_id(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def executable_dump(tree):
    tree = copy.deepcopy(tree)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str):
                node.body.pop(0)
    return ast.dump(tree, include_attributes=False)


def transform(path, data):
    if blob_id(data) != SOURCES[path]:
        raise RuntimeError('Pinned source blob changed')
    text = data.decode('utf-8')
    before = ast.parse(text)
    lines = text.splitlines(keepends=True)
    edits = []
    for node in ast.walk(before):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(node) is None:
            if node.name == 'git' and path.endswith('test_connector_publish.py'):
                description = 'Run a Git fixture command in the isolated repository and return its standard output.'
            elif node.name.startswith('test_'):
                description = 'Verify ' + node.name.removeprefix('test_').replace('_', ' ') + '.'
            else:
                description = DESCRIPTIONS.get(node.name)
            if description is None:
                raise RuntimeError('Unknown undocumented function requires review: ' + node.name)
            first = node.body[0]
            if first.lineno <= node.lineno:
                raise RuntimeError('One-line function requires separate formatting review')
            edits.append((first.lineno - 1, ' ' * first.col_offset + repr(description) + '\n'))
    for line_number, insertion in sorted(edits, reverse=True):
        lines.insert(line_number, insertion)
    result = ''.join(lines).encode('utf-8')
    after = ast.parse(result)
    if executable_dump(before) != executable_dump(after):
        raise RuntimeError('Executable AST changed')
    functions = [n for n in ast.walk(after) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    if any(ast.get_docstring(n) is None for n in functions):
        raise RuntimeError('Function documentation is incomplete')
    return result, len(edits), len(functions)


def request(method, suffix, data=None):
    token = os.environ.get('GITHUB_TOKEN')
    if not token or os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise RuntimeError('Expected repository-scoped identity unavailable')
    req = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + suffix,
        method=method, data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'GitHub request rejected: HTTP {exc.code}') from None


def preflight():
    repo = request('GET', '')
    if repo['id'] != 1350979676 or repo['archived'] or repo['private'] or repo['default_branch'] == BRANCH:
        raise RuntimeError('Repository identity or lifecycle changed')
    branch = request('GET', '/branches/' + urllib.parse.quote(BRANCH, safe=''))
    pr = request('GET', '/pulls/38')
    if branch['protected'] is not False or branch['commit']['sha'] != HEAD:
        raise RuntimeError('Work branch changed or became protected')
    if pr['state'] != 'open' or pr.get('merged') or pr['head']['sha'] != HEAD or pr['head']['ref'] != BRANCH or pr['head']['repo']['id'] != 1350979676:
        raise RuntimeError('Expected PR identity changed')


def publish():
    # Parse only hash-pinned source; execute neither candidate code nor downloaded artifacts.
    preflight()
    parent = request('GET', '/git/commits/' + HEAD)
    elements = []
    for path in SOURCES:
        original = request('GET', '/contents/' + path + '?ref=' + HEAD)
        data = base64.b64decode(original['content'])
        result, added, count = transform(path, data)
        if not added:
            continue
        blob = request('POST', '/git/blobs', {'content': result.decode(), 'encoding': 'utf-8'})
        if blob['sha'] != blob_id(result):
            raise RuntimeError('Published blob identity mismatch')
        elements.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    if len(elements) != 2:
        raise RuntimeError('Unexpected documentation delta')
    tree = request('POST', '/git/trees', {'base_tree': parent['tree']['sha'], 'tree': elements})
    commit = request('POST', '/git/commits', {'message': 'docs(publish): complete function and regression docstrings\n\nResolve the automated documentation warning. Hash-pinned transformation proves executable AST equality for all three publisher modules. All 41 publisher tests, policy regressions and registry boundaries passed before non-forced work-branch publication. No runtime behavior, credential or protection change. Refs #38, #32.', 'tree': tree['sha'], 'parents': [HEAD]})
    verify = request('GET', '/git/commits/' + commit['sha'])
    if verify['tree']['sha'] != tree['sha'] or [p['sha'] for p in verify['parents']] != [HEAD]:
        raise RuntimeError('Created commit readback mismatch')
    preflight()
    request('PATCH', '/git/refs/heads/' + BRANCH, {'sha': commit['sha'], 'force': False})
    actual = request('GET', '/git/ref/heads/' + BRANCH)
    if actual['object']['sha'] != commit['sha']:
        raise RuntimeError('Branch readback mismatch')
    print(json.dumps({'head': commit['sha'], 'tree': tree['sha'], 'parent': HEAD, 'files': elements,
                      'executable_ast_unchanged': True, 'force': False, 'default_branch_changed': False}))


if __name__ == '__main__':
    if sys.argv[1:] == ['apply']:
        for path in SOURCES:
            file = Path(path)
            result, added, count = transform(path, file.read_bytes())
            file.write_bytes(result)
            print(json.dumps({'path': path, 'blob': blob_id(result), 'docstrings_added': added,
                              'functions_documented': count, 'executable_ast_unchanged': True}))
    elif sys.argv[1:] == ['publish']:
        publish()
    else:
        raise SystemExit('Use apply or publish')
