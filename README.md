# ORGANVM CI relay

This public personal-account repository is a narrow execution plane for audited
public ORGANVM source commits while organization-owned GitHub Actions cannot
receive runners.

The first profile runs the process-environment enactment harness on Linux,
macOS, and Windows. The repository name, commit SHA, and commands are fixed in
the trusted workflow and `config/targets.yml`. A dispatch must repeat the full
40-character allowlisted commit SHA; it accepts no repository URL, branch,
runner label, shell command, secret, or artifact path.

## Trust boundary

- Test jobs fetch public source anonymously by exact SHA.
- Test jobs receive no repository or environment secrets.
- Only GitHub-owned actions pinned to full commit SHAs are used.
- No cross-repository write credential exists in the MVP.
- Future status publication must use a separate job that never checks out or
  executes target code, through a GitHub App installed only on explicitly
  selected target repositories, with only `Commit statuses: read and write`.
- The `target-status` environment must restrict deployment branches to `main`.

## Run the MVP

Open **Actions → Relay: process-environment enactment → Run workflow**, leave
the fixed target and profile selected, and enter the target's full commit SHA.

For the clean publication canary, use:

`ffebb6fa1020098e18020f6a4a845cf933c0df3c`

Each operating-system job uploads a seven-day JSON receipt and observation
files. The workflow summary records the target SHA, profile, and final result.

