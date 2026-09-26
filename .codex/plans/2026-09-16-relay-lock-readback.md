# Relay lock readback repair

Owner: relay PR #30, review finding 4027845296. Require an explicit false
lock_branch.enabled before reporting the proposed enforcement usable. Test
locked, missing and malformed lock state alongside the accepted fixture.

Finding 4027757996 remains a separate ordering decision: timestamps can tie,
and run IDs order creation rather than rerun start. A higher-ID success must
not conceal a lower-ID rerun failure. Preserve fail-closed ordering until a
sound tie policy is verified. This diagnostic App is not the synchronous
merge authority; neither repair substitutes for protected governor canaries.

Verification: all 72 admission/enforcement tests pass on Node 22.23.2; git diff --check passes. No production settings were changed.
