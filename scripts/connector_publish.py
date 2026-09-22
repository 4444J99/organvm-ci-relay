#!/usr/bin/env python3
"""Prepare exact-tree GitHub connector calls without local network credentials.

This module does not call a network, change refs, certify tests, or grant authority.
The caller performs authenticated tool calls and validates their readbacks.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any


class Refused(ValueError):
    """The publication cannot preserve its declared boundary."""


def git(root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks",
         "-c", "core.fsmonitor=false", "-C", str(root), *args],
        check=False, capture_output=True, timeout=30,
    )
    if result.returncode:
        # Do not echo arbitrary repository output or credential-bearing remotes.
        raise Refused("Local Git inspection failed")
    return result.stdout


def oid(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise Refused("Require a full lowercase SHA-1 object ID")
    return value


def entries(root: Path, revision: str) -> dict[str, tuple[str, str, str]]:
    result = {}
    for record in git(root, "ls-tree", "-rz", revision).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        try:
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise Refused("Non-UTF-8 path requires a different transport") from exc
        mode, kind, sha = metadata.decode("ascii").split()
        result[path] = (mode, kind, oid(sha))
    return result


def prepare(root: Path, repository: str, repository_id: int, branch: str,
            expected_head: str, candidate: str, allow_paths: list[str],
            *, max_bytes: int = 1_000_000) -> dict[str, Any]:
    """Export one committed change/merge, never a dirty worktree or local stack."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise Refused("Require a canonical owner/repository name")
    if type(repository_id) is not int or repository_id <= 0:
        raise Refused("Require the observed stable repository ID")
    if branch.startswith("refs/") or branch in {"main", "master", "receipts"}:
        raise Refused("Use an existing non-default, non-receipt work branch")
    git(root, "check-ref-format", "refs/heads/" + branch)
    oid(expected_head)
    oid(candidate)
    if git(root, "status", "--porcelain=v1", "--untracked-files=normal"):
        raise Refused("Commit or preserve worktree changes before preparing")
    # cat-file reads the real commit, not replace refs or display-time grafts.
    raw_commit = git(root, "cat-file", "commit", candidate)
    header, separator, raw_message = raw_commit.partition(b"\n\n")
    if not separator:
        raise Refused("Malformed candidate commit")
    parents = [oid(line[7:].decode("ascii")) for line in header.splitlines()
               if line.startswith(b"parent ")]
    if not parents or parents[0] != expected_head:
        raise Refused("Candidate first parent must equal the observed remote head")
    if len(set(parents)) != len(parents):
        raise Refused("Duplicate parents are not supported")
    tree_sha = oid(git(root, "rev-parse", candidate + "^{tree}").decode().strip())
    base_tree = oid(git(root, "rev-parse", expected_head + "^{tree}").decode().strip())
    old, new = entries(root, expected_head), entries(root, candidate)
    changed = {path for path in old.keys() | new.keys() if old.get(path) != new.get(path)}
    if not changed:
        raise Refused("No tree change; do not manufacture a publication canary")
    if changed != set(allow_paths) or len(allow_paths) != len(changed):
        raise Refused("Explicit allowed paths must equal the complete tree delta")
    # Avoid ambiguous API file/directory replacement ordering.
    for path in changed:
        if any(str(parent) in old or str(parent) in new
               for parent in PurePosixPath(path).parents if str(parent) != "."):
            raise Refused("File/directory transition requires a different transport")
        name = PurePosixPath(path).name
        if (name == ".env" or (name.startswith(".env.") and name != ".env.example")
                or name in {"id_rsa", "id_ed25519"} or name.endswith((".pem", ".key"))):
            raise Refused("Potential credential file requires separate custody review")
    # The caller must verify every parent exists in the target repository.
    known_blobs = {value[2] for parent in parents
                   for value in entries(root, parent).values() if value[1] == "blob"}
    elements = []
    for path in sorted(changed):
        for entry in (old.get(path), new.get(path)):
            if entry is not None and (entry[1] != "blob" or entry[0] not in {"100644", "100755"}):
                raise Refused("Changed symlink/submodule requires a separately reviewed transport")
        mode, kind, sha = new.get(path, old.get(path))
        element: dict[str, Any] = {"path": path, "mode": mode, "type": kind}
        if path not in new:
            element["sha"] = None
        elif sha in known_blobs:
            element["sha"] = sha
        else:
            if int(git(root, "cat-file", "-s", sha)) > max_bytes:
                raise Refused("Blob exceeds connector payload budget")
            blob = git(root, "cat-file", "blob", sha)
            if b"\0" in blob:
                raise Refused("New NUL-containing blob requires a binary-capable transport")
            try:
                element["content"] = blob.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise Refused("New binary blob requires a binary-capable transport") from exc
        elements.append(element)
    try:
        message = raw_message.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Refused("Non-UTF-8 commit message requires another transport") from exc
    plan = {
        "schema": "connector-publication/v1", "status": "prepared",
        "repository_id": repository_id, "repository_full_name": repository,
        "branch": branch, "expected_head_sha": expected_head,
        "local_commit_sha": candidate, "expected_tree_sha": tree_sha,
        "parents": parents,
        "create_tree": {"repository_full_name": repository,
                        "base_tree_sha": base_tree, "tree_elements": elements},
        "create_commit": {"repository_full_name": repository, "message": message,
                          "tree_sha": tree_sha, "parent_sha": parents[0],
                          "additional_parent_shas": parents[1:]},
        "tests_executed": None, "authorized": False,
    }
    if len(json.dumps(plan, ensure_ascii=True).encode("utf-8")) > max_bytes:
        raise Refused("Plan exceeds connector payload budget; use bounded tree batches")
    return plan


def _readback_object(value: Any) -> dict:
    """Refuse absent or malformed connector objects without dereferencing them."""
    if not isinstance(value, dict):
        raise Refused("Missing or malformed connector readback object")
    return value


def verify_preflight(plan: dict, repository: dict, pr: dict, branch: dict) -> None:
    """Validate fresh normalized repo/PR metadata and REST branch readback."""
    repository = _readback_object(repository)
    pr = _readback_object(pr)
    branch = _readback_object(branch)
    permissions = _readback_object(repository.get("permissions"))
    branch_commit = _readback_object(branch.get("commit"))
    if (str(repository.get("id")) != str(plan["repository_id"])
            or repository.get("repository_full_name") != plan["repository_full_name"]
            or repository.get("archived") is not False
            or permissions.get("push") is not True):
        raise Refused("Repository identity, lifecycle or write permission changed")
    if (not repository.get("default_branch")
            or plan["branch"] == repository["default_branch"]
            or branch.get("name") != plan["branch"]
            or branch.get("protected") is not False
            or branch_commit.get("sha") != plan["expected_head_sha"]):
        raise Refused("Branch is protected, unknown, default, or moved")
    if (pr.get("state") != "open" or pr.get("merged") is not False
            or pr.get("head") != plan["branch"]
            or pr.get("head_sha") != plan["expected_head_sha"]
            or pr.get("head_repo_full_name") != plan["repository_full_name"]
            or str(pr.get("head_repo_id")) != str(plan["repository_id"])
            or pr.get("base") == plan["branch"]):
        raise Refused("PR is closed, merged, moved, or bound to another repository")


def verify_created(plan: dict, tree: dict, commit: dict,
                   observed_head: str) -> dict[str, Any]:
    """Return non-forced ref arguments only after exact tree/parent readback."""
    tree = _readback_object(tree)
    commit = _readback_object(commit)
    commit_tree = _readback_object(commit.get("tree"))
    parents = commit.get("parents")
    if not isinstance(parents, list):
        raise Refused("Missing or malformed connector parent collection")
    parent_shas = [_readback_object(parent).get("sha") for parent in parents]
    if (tree.get("sha") != plan["expected_tree_sha"]
            or commit_tree.get("sha") != plan["expected_tree_sha"]
            or parent_shas != plan["parents"]
            or observed_head != plan["expected_head_sha"]):
        raise Refused("Tree, ordered parents, or current branch failed readback")
    return {"repository_full_name": plan["repository_full_name"],
            "branch_name": plan["branch"], "sha": oid(commit.get("sha")),
            "force": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--repository-id", type=int, required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--allow-path", action="append", required=True)
    args = parser.parse_args()
    try:
        plan = prepare(args.root, args.repository, args.repository_id, args.branch,
                       args.expected_head, args.candidate, args.allow_path)
    except (Refused, subprocess.TimeoutExpired) as exc:
        parser.exit(2, f"Refused: {exc}\n")
    print(json.dumps(plan, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
