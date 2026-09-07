#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import sys

allowed = {(3, 11, 16), (3, 12, 14)}
current = sys.version_info[:3]
if current not in allowed:
    raise SystemExit(f"unsupported Python: {'.'.join(map(str, current))}")
PY
python -m pip install --disable-pip-version-check --no-input -e '.[test]'
python -m pip check
test_log="$(mktemp)"
trap 'rm -f "$test_log"' EXIT
python -m pytest tests/ -q | tee "$test_log"
grep -E '^25 passed in [0-9]+([.][0-9]+)?s$' "$test_log"
