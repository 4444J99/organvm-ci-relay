#!/usr/bin/env bash
set -euo pipefail

for required in python3 node npm ffmpeg ffprobe curl tar zip unzip sha256sum; do
  command -v "$required" >/dev/null || {
    echo "missing required tool: $required" >&2
    exit 1
  }
done
python3 - <<'PY'
import sys

want = (3, 11, 16)
if sys.version_info[:3] != want:
    raise SystemExit(f"expected Python 3.11.16, got {sys.version.split()[0]}")
PY
[[ "$(node -p 'process.versions.node')" == "22.23.2" ]]
[[ "${TARGET_SHA:-}" =~ ^[0-9a-f]{40}$ ]]

(
  cd brahma/web
  npm ci --no-audit --no-fund
)

smoke_log="$(mktemp)"
trap 'rm -f "$smoke_log"' EXIT
bash tools/smoke.sh --strict | tee "$smoke_log"
grep -Fx 'SMOKE: PASS' "$smoke_log"
grep -E '^=== Summary: [0-9]+ passed, 0 failed, 0 skipped ===$' "$smoke_log"

bash tools/build_release.sh "$TARGET_SHA"
base="dist/alchemical-synthesizer-${TARGET_SHA}"
for artifact in "${base}.tar.gz" "${base}.zip" dist/SHA256SUMS.txt; do
  [[ -s "$artifact" ]]
done
(
  cd dist
  sha256sum -c SHA256SUMS.txt
)
tar -tzf "${base}.tar.gz" >/dev/null
unzip -tq "${base}.zip" >/dev/null
