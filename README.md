# ORGANVM CI relay

A public execution plane for ORGANVM repositories when an organization cannot
receive GitHub-hosted runners. The relay runs on the healthy account that owns
this repository and fetches allowlisted public source anonymously at an exact
commit SHA.

## One command

```bash
./relay
```

The launcher reads the current `canary` record from `config/targets.json` and
submits all four workflow-dispatch inputs explicitly. There are no repository,
SHA, profile, or provider defaults embedded in the launcher or workflow.
Override only the values that change:

```bash
TARGET_REPO=organvm/process-environment-enactment \
TARGET_SHA=ffebb6fa1020098e18020f6a4a845cf933c0df3c \
PROFILE=process-environment-enactment-v1 \
LEAD_PROVIDER=codex \
./relay
```

The complete runtime contract is four variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TARGET_REPO` | `canary.target` | Public repository to test |
| `TARGET_SHA` | `canary.sha` | Exact source commit; floating refs are rejected |
| `PROFILE` | `canary.profile` | Relay-owned test procedure |
| `LEAD_PROVIDER` | `canary.lead_provider` | Receipt provenance only; it grants no access |

Codex, Claude, Warp, a human, or a future provider invokes the same command.
Switching provider changes only `LEAD_PROVIDER` and the caller's existing
GitHub authentication. The relay repository and trusted `main` workflow are
intentionally fixed; repository ownership, workflow code, and billing do not
move during provider switches.

## Dynamic target policy

`config/targets.json` is the single data-only allowlist. A normal policy PR may
change target records, exact regression SHAs, and the four canary fields. A
target is registered once with its stable repository ID, public visibility,
and supported profiles. The workflow then accepts any full 40-character commit
SHA for that target; no workflow edit is needed per commit.

The schema identifier, fail-closed policy object, and complete `profiles`
object are compared byte-for-data with trusted `main` and cannot change through
this dynamic lane. Profile names, families, descriptions, and exact runtime
metadata therefore remain fixed; target records may refer only to an existing
trusted profile. The base verifier also requires one exact canary record, a
lowercase 40-character SHA, a bounded provenance label, and a public
target/profile pair already present in the registry. Runtime authorization
rechecks the repository's live public visibility, canonical name, and stable
GitHub repository ID.

Profiles are executable, relay-owned files under `profiles/`. Runtime inputs
never accept a runner label, shell command, secret, artifact path, or arbitrary
workflow. The registry binds each target to a stable GitHub repository ID and
to a reviewed profile family. Python matrices are derived only from frozen
profile metadata: exact CPython `3.11.16` and/or `3.12.14`. Hybrid profiles may
also request exact Node `22.23.2`; both Python jobs use the pinned
`actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` action with
automatic package-manager caching disabled. The non-Python family publishes a
non-executed `3.12.14` fallback solely so GitHub can expand the skipped Python
matrix safely. Moving major aliases such as `3.12` and `22`, Node 20, and
target-provided declarative commands are rejected.

Registered execution targets:

| Target | Stable repository ID | Frozen profile and runtime | Push regression |
| --- | ---: | --- | --- |
| `organvm/process-environment-enactment` | `1350942566` | `process-environment-enactment-v1` / native POSIX + Windows | Canary only |
| `organvm/learning-resources` | `1155240211` | `python-ruff-pytest-v1` / Python `3.11.16`, `3.12.14` | `40026461978855cb63dade9ce4a501328c9b8600` |
| `organvm/organvm-engine` | `1160447354` | `organvm-engine-v1` / Python `3.11.16`, `3.12.14` | `f9aeb3f0bc4a329579dcffa2446d813fa8d84141` |
| `organvm/laurea` | `1289397231` | `python-pytest-test-v1` / Python `3.11.16`, `3.12.14` | `faf6c5f67130925518233f5f99a76182b544fb85` |
| `organvm/the-thing-without-a-name` | `1320324017` | `danse-portable-v1` / Python `3.12.14` + Node `22.23.2` | `a5b0a98f903058c9fbb95f8805d2ba1cd3ef2cf6` |
| `organvm/alchemical-synthesizer` | `1157553907` | `alchemical-smoke-release-node22-v1` / Python `3.11.16` + Node `22.23.2` | Not enrolled yet |

Every trust-root push resolves its canary from the registry and also runs the
exact registered Python regression candidates. Manual dispatch remains the
explicit four-variable path for any allowlisted candidate SHA.

`organvm/alchemical-synthesizer` is deliberately allowlisted without a
`regression_candidate`. Its audited source is
`8de2bd7bdbc075a8971e5de224bed5d020b0d8f4`, but it must first pass a manual
dispatch under Node `22.23.2`. Only that green canary may authorize a later
data-only regression record and a target-side Node 22 CI update. This avoids
freezing an EOL Node 20 contract into the relay.

Exact-SHA guarantees apply to the relay and target Git source revisions.
Python profiles currently resolve the dependency ranges declared by each
target at run time, so those executions are networked and non-hermetic. A
receipt attests the verified source identities and the observed test result;
it does not claim byte-for-byte dependency reproducibility. Each receipt records
the exact selected runtime and, on trust-root pushes, the exact expanded
regression matrix without credentials or target artifacts.

The three Wave A trees contain no Git-sourced package dependencies, so there
are no dependency repository refs to pin. Any future `git+https` dependency in
a relay-owned profile must use an immutable 40-character commit pin; raw Git
network commands in profiles are rejected. The Danse profile intentionally
tests its portable contract: the private grain bank must be reported absent on
the public runner, and macOS Vision/hardware behavior remains outside this
Ubuntu regression rather than being treated as a portable success claim.

## Write isolation

The trusted workflow, target registry, and future relay-owned profiles live on
`main`. Canonical JSON/SHA-256 receipt pairs live only on the separate
`receipts` branch. The receipt job runs on a fresh runner, never downloads
target artifacts, and has the workflow's only `contents: write` permission.

`main` must be protected by a repository ruleset. Until that setting is
verified, this repository is an execution prototype rather than a privileged
status-signing root. Cross-repository status publication remains deferred.

## Trust boundary

- Pull requests are evaluated by `pull_request_target`, so GitHub loads the
  policy workflow from the protected base branch rather than from the PR.
- The trusted job anonymously fetches the exact PR-head SHA into a bare,
  blob-filtered repository. It never checks out or executes candidate code.
- Git tree entries freeze the complete workflow directory, both named workflow
  files, the base verifier and tests, the launcher, the complete profile tree,
  and Git attributes that could transform those files.
- The candidate verifier root is seeded from trusted base bytes. Only the raw
  candidate `config/targets.json` blob is overlaid, after regular-file mode and
  two-megabyte size checks. The blob is treated as data.
- The verifier executed by the job always comes from the base checkout and is
  given explicit `--candidate-root` and `--base-root` arguments. Candidate
  edits to the verifier, its tests, workflows, profiles, or launcher cannot
  authorize themselves.
- Test jobs fetch public source anonymously by exact SHA.
- Test jobs receive no repository or environment secrets and have
  `permissions: {}`.
- Only standard GitHub-hosted runners are used.
- GitHub-owned actions are pinned to full commit SHAs.
- Trust-root pushes replay exact registered regression candidates before the
  revision is treated as operational evidence.
- Canonical receipts are generated on a fresh runner from authorization outputs
  and job results; the receipt job never downloads or executes target artifacts.
- Durable receipt commits go only to the `receipts` branch, never trusted `main`.
- `LEAD_PROVIDER` is audit metadata, not an authorization mechanism.
- No payment method, paid runner, organization transfer, or vendor-specific App
  setting is part of normal dispatch.

## Required-check and bootstrap contract

Protect `main` with the required context `Relay trust policy`, expected from
GitHub Actions, and require branches to be strictly up to date with `main`
before merge. Base-branch advances do not themselves create a new
`pull_request_target` run, so strict/up-to-date enforcement is part of the
security boundary. The canonical workflow gives push and manual diagnostics a
different context, `Relay trust policy self-check`; those runs must never be
selected as the PR requirement. Merge queue is not supported until this design
has a separately anchored `merge_group` implementation.

GitHub's status-check identity is an app plus a context string, not a workflow
file identity. A branch with workflow-write access can deliberately create a
second GitHub Actions job named `Relay trust policy`. The trusted check will
still fail because the complete workflow tree changed, but duplicate-context
resolution is GitHub platform behavior. Before relying on the rule, run a live
adversarial canary and verify that a passing duplicate cannot supersede the
failing trusted check. If it can, the native context is not a sufficient trust
anchor; use a workflow-identity-bound ruleset control or a dedicated GitHub App
check identity. Do not paper over that result in repository code.

This PR is the bootstrap: the version of `relay-policy.yml` already on `main`
uses candidate-controlled `pull_request`, so it cannot authenticate the change
that replaces it. Bootstrap exactly once by auditing and merging the expected
head SHA under a narrow administrator bypass. Then let the `main` push
self-check finish, open a benign data-only PR to establish the new required
context on its head SHA, and run frozen-file plus duplicate-name adversarial
canaries. Bind or restore the ruleset only after those checks behave as stated.

After bootstrap, executable trust-root changes fail by design. For a necessary
workflow, verifier, test, launcher, profile implementation or metadata, or governing Git
attributes change, use the same break-glass sequence: record and audit one exact
head SHA, grant the narrowest temporary bypass, merge only that SHA, run the
`main` self-check and adversarial canaries, then remove the bypass and restore
the strict required rule. Normal target, SHA, and canary accounting stays in
the frictionless data-only lane and needs no break glass.
