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
# JUnit binds acceptance to actual positive, all-passing execution, not the
# historical size of the target suite or a human-readable pytest summary.
report_path="$(mktemp)"
trap 'rm -f "$report_path"' EXIT
python -m pytest tests/ -q --junitxml="$report_path"
python - "$report_path" <<'PYTEST_EVIDENCE'
import re
import sys
import xml.etree.ElementTree as ET

with open(sys.argv[1], "rb") as stream:
    payload = stream.read(2_000_001)
if not payload or len(payload) > 2_000_000:
    raise SystemExit("pytest result evidence is missing or oversized")
try:
    text = payload.decode("utf-8-sig")
except UnicodeDecodeError:
    raise SystemExit("pytest result evidence must use UTF-8") from None
if "\x00" in text or "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
    raise SystemExit("pytest result evidence uses unsafe XML declarations")
try:
    root = ET.fromstring(text)
except ET.ParseError:
    raise SystemExit("pytest result evidence is malformed") from None
if root.tag == "testsuites":
    suites = list(root)
elif root.tag == "testsuite":
    suites = [root]
else:
    raise SystemExit("pytest result evidence has an unexpected root")
if not suites or any(suite.tag != "testsuite" for suite in suites):
    raise SystemExit("pytest result evidence has no complete suite inventory")
total = 0
for suite in suites:
    counts = {}
    for name in ("tests", "failures", "errors", "skipped"):
        value = suite.get(name, "")
        if not re.fullmatch(r"0|[1-9][0-9]*", value):
            raise SystemExit("pytest result evidence has invalid counters")
        counts[name] = int(value)
    cases = suite.findall("testcase")
    if (counts["tests"] != len(cases)
            or any(counts[name] for name in ("failures", "errors", "skipped"))
            or any(child.tag not in {"testcase", "properties", "system-out", "system-err"}
                   for child in suite)
            or any(node.tag in {"failure", "error", "skipped"} for node in suite.iter())):
        raise SystemExit("pytest result evidence is inconsistent or not all-passing")
    total += counts["tests"]
if total == 0:
    raise SystemExit("pytest result evidence contains no executed tests")
print(f"Relay pytest evidence verified: {total} passed; zero failures, errors or skips")
PYTEST_EVIDENCE
