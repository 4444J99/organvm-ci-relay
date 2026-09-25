"""Offline, real-Git regressions for connector publication preparation."""
import importlib.util
import os
import shlex
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "connector_publish", Path(__file__).with_name("connector_publish.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q", "-b", "work/test")
        self.git("config", "user.name", "Publication Test")
        self.git("config", "user.email", "publication@example.invalid")
        self.write("keep.txt", b"unchanged\n")
        self.write("change.txt", b"before\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args, data=None, env=None):
        return subprocess.run(["git", "-C", str(self.root), *args],
                              input=data, capture_output=True, check=True,
                              env=env).stdout.decode().strip("\n")

    def write(self, path, data):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)

    def commit(self, message="candidate"):
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def prepare(self, paths, candidate=None, **kwargs):
        return bridge.prepare(self.root, "owner/project", 123, "work/test",
                              self.base, candidate or self.git("rev-parse", "HEAD"),
                              paths, **kwargs)

    def normal(self):
        self.write("change.txt", b"after\r\n\xcf\x80\n")
        self.commit()
        return self.prepare(["change.txt"])

    def replay_tree(self, plan):
        # Model GitHub's overlay with real Git objects, not filesystem copying.
        index = self.root.parent / (self.root.name + "-index")
        self.addCleanup(lambda: index.unlink(missing_ok=True))
        env = dict(os.environ, GIT_INDEX_FILE=str(index))
        self.git("read-tree", plan["create_tree"]["base_tree_sha"], env=env)
        for e in plan["create_tree"]["tree_elements"]:
            if "sha" in e and e["sha"] is None:
                self.git("update-index", "--force-remove", "--", e["path"], env=env)
            else:
                sha = e.get("sha") or self.git(
                    "hash-object", "-w", "--stdin", data=e["content"].encode())
                self.git("update-index", "--add", "--cacheinfo",
                         e["mode"], sha, e["path"], env=env)
        return self.git("write-tree", env=env)

    def readbacks(self, plan):
        repository = {"id": "123", "repository_full_name": "owner/project",
                      "archived": False, "permissions": {"push": True},
                      "default_branch": "main"}
        pr = {"state": "open", "merged": False, "head": "work/test",
              "head_sha": self.base, "head_repo_full_name": "owner/project",
              "head_repo_id": 123, "base": "main"}
        branch = {"name": "work/test", "protected": False,
                  "commit": {"sha": self.base}}
        tree = {"sha": plan["expected_tree_sha"]}
        commit = {"sha": "a" * 40, "tree": tree,
                  "parents": [{"sha": sha} for sha in plan["parents"]]}
        return repository, pr, branch, tree, commit

    def test_exact_text_bytes_and_unmodified_files(self):
        p = self.normal()
        self.assertEqual(self.replay_tree(p), p["expected_tree_sha"])
        self.assertEqual(len(p["create_tree"]["tree_elements"]), 1)
        self.assertFalse(p["authorized"])
        self.assertIsNone(p["tests_executed"])

    def test_add_delete_rename_and_executable_mode(self):
        (self.root / "change.txt").rename(self.root / "renamed.txt")
        self.write("bin/run", b"#!/bin/sh\nexit 0\n")
        (self.root / "bin/run").chmod(0o755)
        self.commit()
        p = self.prepare(["change.txt", "renamed.txt", "bin/run"])
        self.assertEqual(self.replay_tree(p), p["expected_tree_sha"])
        self.assertEqual(p["create_tree"]["tree_elements"][0]["mode"], "100755")

    def test_merge_preserves_order_and_reuses_binary_from_second_parent(self):
        self.git("checkout", "-qb", "incoming")
        self.write("binary.dat", b"\xff\xfe\x00")
        second = self.commit()
        self.git("checkout", "-q", "work/test")
        self.write("change.txt", b"local\n")
        self.base = self.commit()
        self.git("merge", "--no-ff", "-m", "resolved merge", "incoming")
        p = self.prepare(["binary.dat"])
        self.assertEqual(p["parents"], [self.base, second])
        self.assertEqual(p["create_commit"]["additional_parent_shas"], [second])
        self.assertIn("sha", p["create_tree"]["tree_elements"][0])
        self.assertEqual(self.replay_tree(p), p["expected_tree_sha"])

    def test_367_file_merge_reuses_remote_blobs(self):
        self.git("checkout", "-qb", "incoming")
        paths = [f"incoming/{i}.txt" for i in range(365)]
        for path in paths:
            self.write(path, (path + "\n").encode())
        self.commit()
        self.git("checkout", "-q", "work/test")
        self.git("merge", "--no-ff", "--no-commit", "incoming")
        for path in ("resolution-a.txt", "resolution-b.txt"):
            self.write(path, b"resolved locally\n")
            paths.append(path)
        self.commit("merge with two resolutions")
        p = self.prepare(paths)
        elements = p["create_tree"]["tree_elements"]
        self.assertEqual(len(elements), 367)
        self.assertEqual(sum("content" in e for e in elements), 2)
        self.assertEqual(self.replay_tree(p), p["expected_tree_sha"])

    def test_dirty_worktree_is_rejected(self):
        p = self.normal()
        self.write("untracked", b"do not lose")
        with self.assertRaises(bridge.Refused):
            self.prepare(["change.txt"], p["local_commit_sha"])

    def test_incomplete_or_duplicate_scope_is_rejected(self):
        self.normal()
        for paths in ([], ["keep.txt"], ["change.txt", "change.txt"]):
            with self.subTest(paths=paths), self.assertRaises(bridge.Refused):
                self.prepare(paths)

    def test_local_stack_is_rejected(self):
        self.normal()
        self.write("extra", b"next")
        self.commit()
        with self.assertRaises(bridge.Refused):
            self.prepare(["change.txt", "extra"])

    def test_new_binary_fails_closed(self):
        self.write("binary", b"\xff\x00")
        self.commit()
        with self.assertRaises(bridge.Refused):
            self.prepare(["binary"])

    def test_secret_filename_fails_closed(self):
        self.write(".env.production", b"example only")
        self.commit()
        with self.assertRaises(bridge.Refused):
            self.prepare([".env.production"])

    def test_symlink_change_fails_closed(self):
        (self.root / "link").symlink_to("/etc/passwd")
        self.commit()
        with self.assertRaises(bridge.Refused):
            self.prepare(["link"])

    def test_nul_binary_fails_closed(self):
        self.write("binary", b"text\x00binary")
        self.commit()
        with self.assertRaises(bridge.Refused):
            self.prepare(["binary"])

    def test_deleting_or_replacing_symlink_fails_closed(self):
        original_base = self.base
        for replacement in (None, b"regular file\n"):
            with self.subTest(replacement=replacement):
                self.git("reset", "--hard", original_base)
                (self.root / "link").symlink_to("keep.txt")
                self.base = self.commit()
                (self.root / "link").unlink()
                if replacement is not None:
                    self.write("link", replacement)
                self.commit()
                with self.assertRaises(bridge.Refused):
                    self.prepare(["link"])

    def test_deleting_submodule_fails_closed(self):
        self.git("update-index", "--add", "--cacheinfo", "160000", self.base, "module")
        self.git("commit", "-qm", "gitlink baseline")
        self.base = self.git("rev-parse", "HEAD")
        self.git("update-index", "--force-remove", "--", "module")
        self.git("commit", "-qm", "delete gitlink")
        with self.assertRaises(bridge.Refused):
            self.prepare(["module"])

    def test_file_directory_transition_fails_closed(self):
        (self.root / "change.txt").unlink()
        self.write("change.txt/inside", b"new")
        self.commit()
        with self.assertRaises(bridge.Refused):
            self.prepare(["change.txt", "change.txt/inside"])

    def test_payload_budget_is_enforced(self):
        self.normal()
        with self.assertRaises(bridge.Refused):
            self.prepare(["change.txt"], max_bytes=10)

    def test_short_sha_is_rejected(self):
        self.normal()
        with self.assertRaises(bridge.Refused):
            self.prepare(["change.txt"], self.git("rev-parse", "--short", "HEAD"))

    def test_noop_is_rejected(self):
        self.git("commit", "--allow-empty", "-qm", "empty")
        with self.assertRaises(bridge.Refused):
            self.prepare([])

    def test_replacement_refs_do_not_substitute_tested_tree(self):
        p = self.normal()
        self.git("replace", p["local_commit_sha"], self.base)
        self.assertEqual(self.prepare(["change.txt"], p["local_commit_sha"])
                         ["expected_tree_sha"], p["expected_tree_sha"])

    def test_git_inspection_does_not_run_fsmonitor(self):
        marker = self.root / ".git" / "fsmonitor-invoked"
        monitor = self.root / ".git" / "fsmonitor-test"
        monitor.write_text("#!/bin/sh\nprintf invoked > '" + str(marker) + "'\nprintf 'token\\0'\n")
        monitor.chmod(0o755)
        self.git("config", "core.fsmonitor", str(monitor))
        bridge.git(self.root, "status", "--porcelain=v1")
        self.assertFalse(marker.exists())

    def test_missing_partial_clone_blob_is_not_fetched(self):
        self.git("config", "uploadpack.allowFilter", "true")
        blob = self.git("rev-parse", self.base + ":change.txt")
        with tempfile.TemporaryDirectory() as temp:
            clone = Path(temp) / "clone"
            subprocess.run(["git", "clone", "--quiet", "--no-checkout", "--filter=blob:none",
                            self.root.as_uri(), str(clone)], check=True, capture_output=True)
            absent = subprocess.run(["git", "--no-lazy-fetch", "-C", str(clone),
                                     "cat-file", "-e", blob], capture_output=True)
            self.assertNotEqual(absent.returncode, 0)
            with self.assertRaises(bridge.Refused):
                bridge.git(clone, "cat-file", "-e", blob)
            still_absent = subprocess.run(["git", "--no-lazy-fetch", "-C", str(clone),
                                           "cat-file", "-e", blob], capture_output=True)
            self.assertNotEqual(still_absent.returncode, 0)

    def test_valid_readbacks_produce_only_nonforced_update(self):
        p = self.normal()
        repo, pr, branch, tree, commit = self.readbacks(p)
        bridge.verify_preflight(p, repo, pr, branch)
        update = bridge.verify_created(p, tree, commit, self.base)
        self.assertIs(update["force"], False)
        self.assertEqual(update["sha"], "a" * 40)

    def test_merged_closed_moved_and_foreign_pr_are_rejected(self):
        p = self.normal()
        repo, pr, branch, _, _ = self.readbacks(p)
        cases = [("state", "closed"), ("merged", True), ("head_sha", "b" * 40),
                 ("head_repo_id", 999), ("head_repo_full_name", "other/project")]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(bridge.Refused):
                bridge.verify_preflight(p, repo, dict(pr, **{key: value}), branch)

    def test_unknown_or_protected_branch_is_rejected(self):
        p = self.normal()
        repo, pr, branch, _, _ = self.readbacks(p)
        for value in (True, None, "false", 0):
            with self.subTest(value=value), self.assertRaises(bridge.Refused):
                bridge.verify_preflight(p, repo, pr, dict(branch, protected=value))

    def test_repository_identity_permissions_and_default_are_rechecked(self):
        p = self.normal()
        repo, pr, branch, _, _ = self.readbacks(p)
        cases = [("id", 999), ("permissions", {"push": False}), ("archived", True),
                 ("default_branch", "work/test"), ("default_branch", None)]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(bridge.Refused):
                bridge.verify_preflight(p, dict(repo, **{key: value}), pr, branch)

    def test_tree_commit_parent_and_race_mismatch_are_rejected(self):
        p = self.normal()
        _, _, _, tree, commit = self.readbacks(p)
        cases = [(dict(tree, sha="b" * 40), commit, self.base),
                 (tree, dict(commit, tree={"sha": "b" * 40}), self.base),
                 (tree, dict(commit, parents=[]), self.base),
                 (tree, commit, "b" * 40)]
        for tree_read, commit_read, head in cases:
            with self.subTest(read=head), self.assertRaises(bridge.Refused):
                bridge.verify_created(p, tree_read, commit_read, head)


    def configure_filter(self, driver="fixture", kind="clean", *, included=False):
        """Force Git to inspect equal-size bytes rather than only cached stat data."""
        marker = self.root / ".git" / "filter-invoked"
        (self.root / ".git" / "info" / "attributes").write_text(
            f"change.txt filter={driver}\n")
        command = "printf invoked > " + shlex.quote(str(marker)) + "; "
        command += "cat" if kind == "clean" else "exit 1"
        config_args = []
        if included:
            included_config = self.root / ".git" / "included-filter-config"
            self.git("config", "include.path", str(included_config))
            config_args = ["--file", str(included_config)]
        self.git("config", *config_args, f"filter.{driver}.{kind}", command)
        self.git("config", *config_args, f"filter.{driver}.required", "true")
        self.write("change.txt", b"edited\n")  # same size as the index's before\n
        os.utime(self.root / "change.txt", (1_700_000_000, 1_700_000_000))
        return marker

    def test_status_suppresses_clean_filter_and_keeps_dirty_detection(self):
        marker = self.configure_filter()
        result = bridge.git(self.root, "status", "--porcelain=v1")
        self.assertFalse(marker.exists(), "inspection executed a clean filter")
        self.assertIn(b"change.txt", result)

    def test_status_suppresses_process_filter_before_its_handshake(self):
        marker = self.configure_filter(kind="process")
        try:
            result = bridge.git(self.root, "status", "--porcelain=v1")
        except bridge.Refused:
            result = b""
        self.assertFalse(marker.exists(), "inspection executed a process filter")
        self.assertIn(b"change.txt", result)

    def test_status_suppresses_included_mixed_case_dotted_driver(self):
        marker = self.configure_filter("Mixed.Case.Driver", included=True)
        config = (self.root / ".git" / "config").read_bytes()
        index = (self.root / ".git" / "index").read_bytes()
        result = bridge.git(self.root, "status", "--porcelain=v1")
        self.assertFalse(marker.exists())
        self.assertIn(b"change.txt", result)
        self.assertEqual((self.root / ".git" / "config").read_bytes(), config)
        self.assertEqual((self.root / ".git" / "index").read_bytes(), index)

    def test_clean_filter_cannot_mask_dirty_bytes_during_preparation(self):
        plan = self.normal()
        payload = self.root / ".git" / "filter-payload"
        payload.write_bytes((self.root / "change.txt").read_bytes())
        marker = self.configure_filter()
        self.git("config", "filter.fixture.clean",
                 "printf invoked > " + shlex.quote(str(marker))
                 + "; cat " + shlex.quote(str(payload)))
        self.write("change.txt", b"x" * len(payload.read_bytes()))
        os.utime(self.root / "change.txt", (1_700_000_000, 1_700_000_000))
        with self.assertRaises(bridge.Refused):
            self.prepare(["change.txt"], plan["local_commit_sha"])
        self.assertFalse(marker.exists())

    def test_unused_filter_definition_does_not_block_publication(self):
        plan = self.normal()
        self.git("config", "filter.unused.clean", "exit 99")
        self.git("config", "filter.unused.process", "exit 99")
        self.git("config", "filter.unused.required", "true")
        self.assertEqual(self.prepare(["change.txt"])["expected_tree_sha"],
                         plan["expected_tree_sha"])

    def test_unrepresentable_filter_key_is_refused_without_execution(self):
        marker = self.configure_filter("unusual=driver")
        with self.assertRaises(bridge.Refused):
            bridge.git(self.root, "status", "--porcelain=v1")
        self.assertFalse(marker.exists())


    def test_initialized_submodule_status_is_refused_before_nested_filters(self):
        child = self.root / "module"
        child.mkdir()
        def child_git(*args):
            return subprocess.run(["git", "-C", str(child), *args],
                                  check=True, capture_output=True).stdout.decode().strip()
        child_git("init", "-q")
        child_git("config", "user.name", "Submodule Fixture")
        child_git("config", "user.email", "submodule@example.invalid")
        tracked = child / "tracked.txt"
        tracked.write_text("before\n")
        child_git("add", ".")
        child_git("commit", "-qm", "child base")
        self.git("update-index", "--add", "--cacheinfo", "160000",
                 child_git("rev-parse", "HEAD"), "module")
        self.git("commit", "-qm", "record child")
        marker = child / ".git" / "nested-filter-invoked"
        (child / ".git" / "info" / "attributes").write_text("tracked.txt filter=nested\n")
        child_git("config", "filter.nested.clean",
                  "printf invoked > " + shlex.quote(str(marker)) + "; cat")
        tracked.write_text("edited\n")
        os.utime(tracked, (1_700_000_000, 1_700_000_000))
        with self.assertRaises(bridge.Refused):
            bridge.git(self.root, "status", "--porcelain=v1")
        self.assertFalse(marker.exists())

    def test_uninitialized_gitlink_does_not_invoke_child_inspection(self):
        self.git("update-index", "--add", "--cacheinfo", "160000", self.base, "module")
        self.git("commit", "-qm", "uninitialized gitlink")
        result = bridge.git(self.root, "status", "--porcelain=v1")
        self.assertIsInstance(result, bytes)


if __name__ == "__main__":
    unittest.main()