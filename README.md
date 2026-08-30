# ORGANVM CI relay

A public execution plane for ORGANVM repositories when an organization cannot
receive GitHub-hosted runners. The relay runs on the healthy account that owns
this repository and fetches allowlisted public source anonymously at an exact
commit SHA.

## One command

```bash
bash relay.sh
```

That runs the known-good canary. Override only the values that change:

```bash
TARGET_REPO=organvm/process-environment-enactment \
TARGET_SHA=ffebb6fa1020098e18020f6a4a845cf933c0df3c \
PROFILE=process-environment-enactment-v1 \
LEAD_PROVIDER=codex \
bash relay.sh
```

The complete runtime contract is six variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CI_RELAY_REPO` | `4444J99/organvm-ci-relay` | Healthy GitHub billing/execution boundary |
| `CI_RELAY_REF` | `main` | Trusted relay workflow ref |
| `TARGET_REPO` | canary repository | Public repository to test |
| `TARGET_SHA` | known-good canary SHA | Exact source commit; floating refs are rejected |
| `PROFILE` | canary profile | Relay-owned test procedure |
| `LEAD_PROVIDER` | `operator` | Receipt provenance only; it grants no access |

Codex, Claude, Warp, a human, or a future provider invokes the same command.
Switching provider changes only `LEAD_PROVIDER` and the caller's existing
GitHub authentication. Repository ownership, workflow code, and billing do not
move.

## Dynamic target policy

`config/targets.json` is the single allowlist. A target is registered once with
its stable repository ID, public visibility, and supported profiles. The
workflow then accepts any full 40-character commit SHA for that target; no
workflow edit is needed per commit.

Profiles remain trusted code in the relay. Runtime inputs never accept a runner
label, shell command, secret, artifact path, or arbitrary workflow.

## Trust boundary

- Test jobs fetch public source anonymously by exact SHA.
- Test jobs receive no repository or environment secrets and have
  `permissions: {}`.
- Only standard GitHub-hosted runners are used.
- GitHub-owned actions are pinned to full commit SHAs.
- Canonical receipts are generated on a fresh runner from authorization outputs
  and job results; the receipt job never downloads or executes target artifacts.
- `LEAD_PROVIDER` is audit metadata, not an authorization mechanism.
- No payment method, paid runner, organization transfer, or vendor-specific App
  setting is part of normal dispatch.

