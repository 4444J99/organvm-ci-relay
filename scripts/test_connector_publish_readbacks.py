"""Malformed connector responses must refuse without proposing a ref update."""
from __future__ import annotations

import copy
import unittest

import connector_publish as bridge


class MalformedReadbackTests(unittest.TestCase):
    def setUp(self):
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
        records = [self.repository, self.pr, self.branch]
        for index in range(len(records)):
            for value in (None, [], "response unavailable", 0, False):
                args = records.copy()
                args[index] = value
                with self.subTest(index=index, value=value), self.assertRaises(bridge.Refused):
                    bridge.verify_preflight(self.plan, *args)

    def test_malformed_nested_preflight_readbacks_refuse(self):
        for index, key in ((0, "permissions"), (2, "commit")):
            for value in (None, [], "unknown", 0, False):
                args = copy.deepcopy([self.repository, self.pr, self.branch])
                args[index][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(bridge.Refused):
                    bridge.verify_preflight(self.plan, *args)

    def test_malformed_top_level_created_readbacks_refuse(self):
        for value in (None, [], "response unavailable", 0, False):
            with self.subTest(target="tree", value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, value, self.commit, self.head)
            with self.subTest(target="commit", value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree, value, self.head)

    def test_malformed_created_tree_refuses(self):
        for value in (None, [], "unknown", 0, False):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree,
                                      dict(self.commit, tree=value), self.head)

    def test_malformed_parent_collection_refuses(self):
        for value in (None, {}, "unknown", 0, False, (self.commit["parents"][0],)):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree,
                                      dict(self.commit, parents=value), self.head)

    def test_malformed_parent_record_refuses(self):
        for value in (None, [], "unknown", 0, False, {}, {"sha": None}):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_created(self.plan, self.tree,
                                      dict(self.commit, parents=[value]), self.head)

    def test_valid_response_and_ordered_merge_parents_are_preserved(self):
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


if __name__ == "__main__":
    unittest.main()
