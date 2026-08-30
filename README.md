# ORGANVM CI relay

A public execution plane for ORGANVM repositories when an organization cannot
receive GitHub-hosted runners. The relay runs on the healthy account that owns
this repository and fetches allowlisted public source anonymously at an exact
commit SHA.

## One command

```bash
./relay
```

That runs the known-good canary. Override only the values that change:

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
| `TARGET_REPO` | canary repository | Public repository to test |
| `TARGET_SHA` | known-good canary SHA | Exact source commit; floating refs are rejected |
| `PROFILE` | canary profile | Relay-owned test procedure |
| `LEAD_PROVIDER` | `operator` | Receipt provenance only; it grants no access |

Codex, Claude, Warp, a human, or a future provider invokes the same command.
Switching provider changes only `LEAD_PROVIDER` and the caller's existing
GitHub authentication. The relay repository and trusted `main` workflow are
intentionally fixed; repository ownership, workflow code, and billing do not
move during provider switches.

## Dynamic target policy

`config/targets.json` is the single allowlist. A target is registered once with
its stable repository ID, public visibility, and supported profiles. The
workflow then accepts any full 40-character commit SHA for that target; no
workflow edit is needed per commit.

Profiles are executable, relay-owned files under `profiles/`. Runtime inputs
never accept a runner label, shell command, secret, artifact path, or arbitrary
workflow. The registry binds each target to a stable GitHub repository ID and
to a reviewed profile family.

Registered execution targets:

| Target | Profile |
| --- | --- |
| `organvm/process-environment-enactment` | `process-environment-enactment-v1` |
| `organvm/learning-resources` | `python-ruff-pytest-v1` |
| `organvm/organvm-engine` | `organvm-engine-v1` |

Every trust-root push runs the known-good cross-platform process canary plus
the exact registered Python regression candidates. Manual dispatch remains the
four-variable path for any allowlisted candidate SHA.

Exact-SHA guarantees apply to the relay and target Git source revisions.
Python profiles currently resolve the dependency ranges declared by each
target at run time, so those executions are networked and non-hermetic. A
receipt attests the verified source identities and the observed test result;
it does not claim byte-for-byte dependency reproducibility.

## Write isolation

The trusted workflow, target registry, and future relay-owned profiles live on
`main`. Canonical JSON/SHA-256 receipt pairs live only on the separate
`receipts` branch. The receipt job runs on a fresh runner, never downloads
target artifacts, and has the workflow's only `contents: write` permission.

`main` must be protected by a repository ruleset. Until that setting is
verified, this repository is an execution prototype rather than a privileged
status-signing root. Cross-repository status publication remains deferred.

## Trust boundary

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
