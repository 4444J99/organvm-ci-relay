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

Profiles remain trusted code in the relay. Runtime inputs never accept a runner
label, shell command, secret, artifact path, or arbitrary workflow.

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
- Canonical receipts are generated on a fresh runner from authorization outputs
  and job results; the receipt job never downloads or executes target artifacts.
- Durable receipt commits go only to the `receipts` branch, never trusted `main`.
- `LEAD_PROVIDER` is audit metadata, not an authorization mechanism.
- No payment method, paid runner, organization transfer, or vendor-specific App
  setting is part of normal dispatch.
