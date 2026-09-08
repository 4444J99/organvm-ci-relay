# ORGANVM Relay Admission App

This dedicated GitHub App converts the base-controlled `relay-policy.yml`
workflow result into an app-bound check named `Relay admission / trusted`.
Requiring that context together with this App's numeric ID prevents another
GitHub Actions job with the same display name from satisfying protection.

## Install

1. Deploy this directory on an HTTPS Node 22 host with `npm start`.
2. Create the private GitHub App from `app-manifest.json`, replacing the two
   deployment URLs. Generate its private key and install it only on
   `4444J99/organvm-ci-relay`.
3. Set `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`,
   `REPOSITORY=4444J99/organvm-ci-relay`, `REPOSITORY_ID=1350979676`, and
   `PORT` on the host.
4. Replace the numeric placeholder `0` used for `app_id` in
   `enforcement/branch-protection.json`, then apply it with an administrator
   token:

```bash
curl --fail-with-body --request PUT \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GH_ADMIN_TOKEN" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/4444J99/organvm-ci-relay/branches/main/protection \
  --data-binary @enforcement/branch-protection.json
```

The payload requires an up-to-date base, one independent approving review,
fresh approval after the latest push, resolved conversations, linear history,
and enforcement for administrators. It disables routine force-push/deletion
paths and binds the required check to this App ID.

## Enforcement proof

After installation, recreate the terminal canaries from current `main`:

- benign data-only PR: trusted workflow and App check succeed; after an
  independent approval, GitHub reports the PR mergeable;
- nonexistent operational SHA: no App success check is published and GitHub
  reports the PR blocked;
- forged stable repository ID: no App success check is published and GitHub
  reports the PR blocked;
- duplicate `Relay admission / trusted` check from GitHub Actions: GitHub
  reports the PR blocked because its producer App ID differs;
- advance `main` after a benign success: strict status checks report the PR
  behind/blocked until it is updated and re-admitted.

Record the REST mergeability payload and check-suite producer App IDs for each
case. Never merge adversarial canaries.
