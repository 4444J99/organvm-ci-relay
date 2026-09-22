# Publish tested Git trees through the connected GitHub tools

Owner: [Chat-first execution issue #32](https://github.com/4444J99/organvm-ci-relay/issues/32).
This is a standalone, local preparation/verification utility. It is not a new
broker, credential store, dispatcher, lease, runner, or trust-root component.
Existing relay workflows, profiles, verifier and admission policy do not use it.

A failed shell `git push` does not prove that authenticated GitHub writes are
unavailable. The connected `create_tree`, `create_commit` (including ordered
additional parents), and `update_ref(force=false)` operations can publish the
same file tree without copying the connection's credentials into a shell.
The remote commit ID can differ because the connector supplies commit metadata;
tree identity and ordered parent identity must match. Never carry old commit-SHA
check results onto the newly created commit.

## Existing-PR publication sequence

1. Read current repository instructions, actual permissions, stable repository ID,
   visibility, default branch, PR state/head/base, and branch protection. Check
   active ownership and any genuinely target-native admission requirement. Do not
   reopen or push an already merged/superseded PR. A coordination reference alone
   does not impose another repository's lease rules.
2. Preserve a clean, committed local candidate whose first parent is the exact
   current remote work-branch head. Additional merge parents must already exist
   in that same remote repository; read every parent's Git object there first.
   Record actual test commands/results separately, bound to this candidate/tree.
3. Run the helper in a private execution workspace, with an exact explicit list
   of every changed path. Its JSON contains source bytes: never publish it to an
   issue, public receipt, or another repository. Perform normal secret/content
   review; filename screening is not a secret scanner or publication approval.

   ```sh
   python scripts/connector_publish.py --root /path/to/checkout \
     --repository OWNER/REPO --repository-id VERIFIED_ID \
     --branch EXISTING_WORK_BRANCH --expected-head FULL_REMOTE_SHA \
     --candidate FULL_LOCAL_SHA --allow-path path/one --allow-path path/two
   ```

4. Call `verify_preflight` with fresh normalized `get_repo` / `get_pr_info` results
   and the REST branch object. Preserve private/public boundaries and target
   rules in addition to these structural checks. A result is still `prepared`:
   the helper does not certify tests, authority, admission, or execution.
5. Call `GitHub.create_tree` with the generated `create_tree` arguments. Require
   its returned SHA to equal `expected_tree_sha` before creating a commit. The
   base tree preserves unmodified files. Blobs already in any verified parent
   are reused by SHA; only new UTF-8 blobs carry content.
6. Call `GitHub.create_commit` with the generated `create_commit` arguments. Read
   the new Git commit back, including its tree and complete ordered parents.
   Re-read the work branch and current PR immediately before updating it.
   Re-run `verify_preflight`, then `verify_created`; only use its returned
   `update_ref` arguments. Never set `force=true` or update a default/protected
   branch. An API-generated commit does not preserve a local signature; a
   signature requirement needs a supported signer, not a protection bypass.
7. Read back the branch and PR to establish the published SHA. Run the required
   checks/reviews against that exact SHA. Merge only under the target's existing
   authority and protections, using `expected_head_sha`; verify the merge and
   actual destination ref afterward. Published, merge-ready and merged are
   distinct outcomes. No deployment or scheduled-Chat provenance is inferred.

`update_ref(force=false)` prevents non-fast-forward overwrites. It is not an
atomic expected-old-SHA compare-and-swap. Pre/post readback narrows and detects
races but does not create a lock. Where native policy requires stronger
serialization, use its existing admitted rail; do not invent another lock.

## Bounded support and honest refusal

The helper handles ordinary files, executable modes, deletions, renames, and
multi-parent merges. New binary blobs, changed symlinks/submodules, ambiguous
file/directory transitions, local unpublished commit stacks, dirty worktrees,
incomplete scopes and over-budget payloads are refused before publication.
These require a capable authorized transport or explicit bounded tree batching,
not weaker verification. A large changed-file count alone is not a blocker:
the 367-file regression reuses 365 remote-parent blobs and transmits only the
two local resolutions. No single connector request size is guaranteed.

Git inspection disables replacement objects, lazy promisor fetches, optional
index locks and configured filesystem-monitor hooks. Missing local objects must
be hydrated through the approved source-read path before preparation; the helper
does not silently fetch them. Tests include an actual partial clone and a local
filesystem-monitor sentinel to verify these refusal boundaries.

Tests require Python 3.10+ and Git 2.47+, no third-party packages or network:

```sh
python -m unittest discover -s scripts -p 'test_connector_publish*.py' -v
```

API contracts:
- https://docs.github.com/en/rest/git/trees#create-a-tree
- https://docs.github.com/en/rest/git/commits#create-a-commit
- https://docs.github.com/en/rest/git/refs#update-a-reference
