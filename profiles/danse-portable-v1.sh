#!/usr/bin/env bash
set -euo pipefail

for required in python node git ffmpeg ffprobe; do
  command -v "$required" >/dev/null || {
    echo "missing required tool: $required" >&2
    exit 1
  }
done
python - <<'PY'
import sys

want = (3, 12, 14)
if sys.version_info[:3] != want:
    raise SystemExit(f"expected Python 3.12.14, got {sys.version.split()[0]}")
PY
[[ "$(node -p 'process.versions.node')" == "22.23.2" ]]

python -m pip install --disable-pip-version-check --no-input '.[media]'
python -m pip check

check_log="$(mktemp)"
interaction_log="$(mktemp)"
trap 'rm -f "$check_log" "$interaction_log"' EXIT

python scripts/check-danse.py | tee "$check_log"
grep -Fx 'danse: every invariant holds' "$check_log"
grep -F 'note: 3 invariant(s) need the grain bank, which this machine does not have' "$check_log"
python scripts/tests/pages-artifact.test.py
python scripts/tests/release-manifest.test.py
python scripts/tests/rights.test.py
python scripts/tests/danse-delivery.test.py
python release/frames/test_score_motion_contract.py
node scripts/tests/interaction.test.mjs | tee "$interaction_log"
grep -Fx 'interaction: 20 deterministic checks passed' "$interaction_log"
python -m py_compile render/*.py pipeline/*.py sound/*.py submission/*.py scripts/*.py
node --check interaction/adapter.js
node --check interaction/camera.js
node --check interaction/controller.js
node --check interaction/session.js
node --check sound/control.mjs
bash -n done.sh
