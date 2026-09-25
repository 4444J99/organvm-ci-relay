"""Malformed connector responses must refuse without proposing a ref update."""
from __future__ import annotations

import copy
import unittest

import connector_publish as bridge


class MalformedReadbackTests(unittest.TestCase):
    def setUp(self):
        """Build mutually consistent normalized connector readbacks."""
        self.head = "1" * 40
        self.tree_sha = "2" * 40
        self.created_sha = "3" * 40
        self.plan = {
            "repository_id": 123,
            "repository_full_name": "owner/project",
            "branch": "work/test",
            "expected_head_sha": self.head,
            "expected_tree_sha": self.tree_sha,
            "parents": [self.head],
        }
        self.repository = {
            "id": "123", "repository_full_name": "owner/project",
            "archived": False, "permissions": {"push": True},
            "default_branch": "main",
        }
        self.pr = {
            "state": "open", "merged": False, "head": "work/test",
            "head_sha": self.head, "head_repo_full_name": "owner/project",
            "head_repo_id": 123, "base": "main",
        }
        self.branch = {
            "name": "work/test", "protected": False,
            "commit": {"sha": self.head},
        }
        self.tree = {"sha": self.tree_sha}
        self.commit = {
            "sha": self.created_sha, "tree": {"sha": self.tree_sha},
            "parents": [{"sha": self.head}],
        }

    def test_malformed_top_level_preflight_readbacks_refuse(self):
        """Reject non-object repository, PR, and branch responses."""
        records = [self.repository, self.pr, self.branch]
        for index in range(len(records)):
            for value in (None, [], "response unavailable", 0, False):
                args = records.copy()
                args[index] = value
                with self.subTest(index=index, value=value), self.assertRaises(bridge.Refused):
                    bridge.verify_preflight(self.plan, *args)

    def test_malformed_nested_preflight_readbacks_refuse(self):
        """Reject malformed permission and branch-commit objects."""
        for index, key in ((0, "permissions"), (2, "commit")):
            for value in (None, [], "unknown", 0, False):
                args = copy.deepcopy([self.repository, self.pr, self.branch])
                args[index][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(bridge.Refused):
                    bridge.verify_preflight(self.plan, *args)

    def test_malformed_top_level_created_readbacks_refuse(self):
        """Reject non-object created tree and commit responses."""
        for value in (None, [], "response unavailable", 0, False):
            with self.subTest(target="tree", value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, value, self.commit, self.head)
            with self.subTest(target="commit", value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree, value, self.head)

    def test_malformed_created_tree_refuses(self):
        """Reject a malformed tree nested in a created commit."""
        for value in (None, [], "unknown", 0, False):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree,
                                      dict(self.commit, tree=value), self.head)

    def test_malformed_parent_collection_refuses(self):
        """Require a JSON array for the created commit parent collection."""
        for value in (None, {}, "unknown", 0, False, (self.commit["parents"][0],)):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree,
                                      dict(self.commit, parents=value), self.head)

    def test_malformed_parent_record_refuses(self):
        """Reject malformed parent objects and absent parent identifiers."""
        for value in (None, [], "unknown", 0, False, {}, {"sha": None}):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree,
                                      dict(self.commit, parents=[value]), self.head)

    def test_missing_malformed_or_self_targeting_pr_base_refuses(self):
        """Require a nonblank string base distinct from the work branch."""
        malformed = (None, {}, {"ref": "main"}, [], False, True, 0, 1,
                     "", " \t", self.plan["branch"])
        for value in malformed:
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_preflight(self.plan, self.repository,
                                        dict(self.pr, base=value), self.branch)
        missing = {key: value for key, value in self.pr.items() if key != "base"}
        with self.subTest(value="absent"), self.assertRaises(bridge.Refused):
            bridge.verify_preflight(self.plan, self.repository, missing, self.branch)
        for value in ("main", "release/next"):
            with self.subTest(valid_base=value):
                bridge.verify_preflight(self.plan, self.repository,
                                        dict(self.pr, base=value), self.branch)

    def test_valid_response_and_ordered_merge_parents_are_preserved(self):
        """Preserve valid publication and exact ordered merge-parent checks."""
        bridge.verify_preflight(self.plan, self.repository, self.pr, self.branch)
        result = bridge.verify_created(self.plan, self.tree, self.commit, self.head)
        self.assertEqual(result, {
            "repository_full_name": "owner/project", "branch_name": "work/test",
            "sha": self.created_sha, "force": False,
        })
        second = "4" * 40
        plan = dict(self.plan, parents=[self.head, second])
        commit = dict(self.commit, parents=[{"sha": self.head}, {"sha": second}])
        self.assertEqual(bridge.verify_created(plan, self.tree, commit, self.head), result)
        with self.assertRaises(bridge.Refused):
            bridge.verify_created(plan, self.tree,
                                  dict(commit, parents=list(reversed(commit["parents"]))), self.head)


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


if __name__ == "__main__":
    unittest.main()
