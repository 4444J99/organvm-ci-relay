# Alchemical relay media runtime repair

Run https://github.com/4444J99/organvm-ci-relay/actions/runs/35109829456 executed the registered profile against target 8de2bd7bdbc075a8971e5de224bed5d020b0d8f4 using relay b53a47f93ef861044eb5a3b888a4fc72801dc4cf. Runtime setup and exact-source fetch passed, then the strict profile refused missing ffmpeg. The failure receipt was committed by the isolated receipt job; this is an executed setup failure, not runner admission or a passing smoke test.

Install the relay-owned ffmpeg package (which includes ffprobe) before candidate fetch in both Python dispatch and regression jobs, only for alchemical-smoke-release-node22-v1. Bound installation to five minutes and preserve failure propagation. Keep target scripts unprivileged, profiles strict, the six-target denominator unchanged, and regression enrollment gated on an actual green run.

Policy validation binds the package, condition, deadline, shell, position and failure policy. Six mutation regressions cover both jobs. Node 22 plus Bash 5 validation: 258 policy regressions, four dynamic acceptance cases, 25 receipt-runtime cases; policy self-check and actionlint pass. The system Bash 3 parser gave a pre-existing malformed-heredoc test false acceptance; selecting the contract-required Bash 5 resolved the environment mismatch without changing the test.

Integrate into existing PR 30. This executable-root change still requires the documented independently reviewed promotion and protected governor acceptance; no bypass or main deployment is implied. After promotion, execute the same exact target and preserve the new receipt separately from the earlier failure.
