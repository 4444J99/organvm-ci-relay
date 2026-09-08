# ORGANVM Relay Admission App

This dedicated GitHub App converts the base-controlled `relay-policy.yml`
workflow result into an app-bound check named `Relay admission / trusted`.
Requiring that context together with this App's numeric ID prevents another
GitHub Actions job with the same display name from satisfying protection.

## Install

1. Select an independently audited immutable revision using the pinned-release procedure below; deploy that artifact on an approved HTTPS Node 22 host with `npm start`.
2. Create the private GitHub App from `app-manifest.json`, replacing the two
   deployment URLs. Generate its private key and install it only on
   `4444J99/organvm-ci-relay`.
3. Set `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`,
   `REPOSITORY=4444J99/organvm-ci-relay`, `REPOSITORY_ID=1350979676`, `INSTALLATION_ID`, and
   `PORT` on the host.
4. Generate `protection.rendered.json` with the positive App ID using
   `node enforcement/render-config.mjs "$APP_ID" > protection.rendered.json`,
   then apply that typed payload with the separate administrator credential:

```bash
curl --fail-with-body --request PUT \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GH_ADMIN_TOKEN" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/4444J99/organvm-ci-relay/branches/main/protection \
  --data-binary @protection.rendered.json
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

## September 8 continuation: installation and enforcement hold

PR #30 is the canonical implementation. Do not create a second admission App or
promote a passing policy test to production enforcement. The live repository is
personal-account owned (ID `1350979676`); GitHub documents workflow-required rules
at organization/enterprise scope. The selected producer boundary here is the
existing dedicated App ID, not the shared GitHub Actions App ID.

The current base rejects #30 at the frozen executable-root check because this PR
changes `scripts/verify-policy.mjs`. That rejection is expected and remains a
promotion gate. Do not change the base workflow, bypass protection, or merge an
adversarial canary to make this PR green. An independently reviewed, exact-revision
trust-root promotion path is still required before merging the verifier delta.

Deploy only an independently audited immutable commit and record the exact
`admission-app` tree ID plus archive SHA-256 **before** granting the App key to that
artifact. Disable branch-following deploys and automatic updates from `main`.
The directory is not frozen by the current base policy. A change to it must not
reach the credentialed deployment until a separately approved immutable release
and its digest replace the prior deployment record. The deployment host must run
one instance only: this implementation serializes publication inside that process
and rejects concurrent deliveries with 503. It is not a distributed queue.

Add `INSTALLATION_ID` to the required environment values. Pin it to the installation
selected for this repository; do not install on all repositories. Permissions stay
Actions/Contents/Pull requests/Metadata read and Checks write. Do not add Secrets,
Administration, Organization, or cross-repository status permissions to this App.
The separate administrator credential needs repository Administration write to
apply protection and Administration read for readback; it never enters this App.

The service processes successful, failed, cancelled and pending trusted runs. It
re-reads the latest exact-head run before publishing, including its current attempt
and captured base SHA. Delayed success deliveries cannot deliberately replay an
older attempt. Unrelated PR associations no longer mask the unique `main` PR.
Incomplete history fails closed. Each API call is bounded to 1.5 seconds, intake
has a two-second absolute deadline, and errors return generic 503 responses.
A 503 is **not accepted custody**. GitHub does not automatically redeliver failed
webhooks: the installer must arrange authorized redelivery through the existing
operational process, observe it, and prove failure-after-success revocation before
activation. Do not invent a second scheduler or receipt ledger for this purpose.

### Administrator application and readback

1. Refresh repository ID, current main and PR heads, reviews, workflow checkout
   identities, existing branch protection and inherited rulesets. Save the original
   GET payloads and timestamp as rollback evidence. Resolve substantive review and
   the frozen-root promotion gate before choosing the deployment commit.
2. Verify an eligible independent reviewer exists. This tree has no CODEOWNERS;
   `require_code_owner_reviews` alone does not create an owner or satisfy independent
   approval. Preserve the mandatory independent approval and latest-push rule.
3. Create the private App from the supplied manifest with real HTTPS endpoints,
   deploy the audited immutable artifact with its generated secrets, and verify a
   signed test delivery. The instance must be on an approved, existing host; do not
   purchase hosting or authorize new account/billing commitments.
4. Generate a typed payload with the real positive App ID:

   `node enforcement/render-config.mjs "$APP_ID" > protection.rendered.json`

   The generator rejects zero, negative IDs, strings that are not decimal IDs,
   and unsafe integers. Apply `protection.rendered.json` using the PUT shown above,
   then GET `/repos/4444J99/organvm-ci-relay/branches/main/protection` to
   `protection.readback.json` and run:

   `node enforcement/verify-readback.mjs protection.readback.json "$APP_ID"`

5. Independently GET `/repos/4444J99/organvm-ci-relay/rulesets?includes_parents=true&per_page=100`
   through every page; GET each inherited definition and
   `/repos/4444J99/organvm-ci-relay/rules/branches/main`. Review combined restrictions
   and bypass actors. A successful PUT or one empty collection does not substitute
   for readback of the effective branch behavior.
6. Execute the matrix below with the actual current base/head, recorded producer
   App IDs, run attempts, independent review and GitHub merge responses. Read
   mergeability again if GitHub returns `null`; it is not a decision.

| Canary | Required merge-decision observation |
| --- | --- |
| Benign current-base data-only PR | Exact App result succeeds; independent approval exists; guarded merge succeeds. |
| Stale/nonexistent operational SHA | Trusted admission fails; PR cannot merge. |
| Forged/nonexistent stable repository ID | Trusted admission fails; PR cannot merge. |
| Frozen workflow/verifier/profile changed | Trusted root gate fails; ordinary merge cannot bypass promotion review. |
| Trusted failure + lookalike success from Actions/another App | Required producer remains failed and merge is blocked. |
| Prior App success then same-head rerun fails/cancels | Latest App result becomes failure; prior success cannot satisfy merge. |
| Older success delivery after newer failed run | Latest failure remains authoritative; merge stays blocked. |
| Main advances after success | Strict current-base validation blocks until update and fresh admission. |
| Webhook busy/timeout followed by authorized redelivery | 503 is recorded, delivery is retried, resulting failure/success is actually observed. |

Never submit an actual adversarial merge while effective enforcement is unknown.
First obtain a definitive blocked decision with the trusted failure present. If a
negative case appears mergeable, preserve it as failed enforcement and stop that
canary; do not risk landing it. A bounded benign merge is allowed only after all
required controls and independent approval are proved. Record actual attempts only
when safe and authorized; distinguish API eligibility from a performed merge.

### Rollback

Keep the App key out of unreviewed source. On an admission regression, stop accepting
new work, revoke affected successful check results through the installed App where
possible, and restore the last independently audited immutable App artifact. Keep
main protected and retain the required producer check while repairs proceed. If the
App identity must be replaced, repeat identity binding and all canaries. Restoring
previously unprotected settings or adding a bypass is not a rollback strategy.
Keep the existing receipt-v3 ledger untouched; all App installation/readback/canary
observations go into the existing activation evidence register.

Sources: [branch protection API](https://docs.github.com/en/rest/branches/branch-protection),
[workflow-required rule scope](https://docs.github.com/enterprise-cloud%40latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[failed webhook redelivery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
