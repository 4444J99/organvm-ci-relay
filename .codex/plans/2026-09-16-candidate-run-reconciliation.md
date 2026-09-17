# Candidate-specific diagnostic reconciliation

Owner: relay PR #30; review finding 4000014153.

Live run 35113594196 binds workflow head_sha to the candidate, not the base.
Correct webhook/list/detail identity to that invariant. Query the exact candidate
and event instead of the workflow lifetime. Preserve independent checkout-log
base/head proof, attempt ordering, duplicate rejection and pagination drift refusal.
Reject filtered history at 1,000 results explicitly; this is an exceptional
candidate-specific coverage limit, never successful admission. The synchronous
governor remains the selected merge authority.

Validation: all 64 admission/enforcement/server tests pass on Node 22. Existing
unchanged policy/media-runtime test evidence remains bound to its source blobs.
No App deployment, trust promotion, enforcement activation, or merge is claimed.
