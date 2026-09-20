"""Exercise the real profile shell without network, secrets, or hosted runners.

Installation and runtime selection use fixtures; the JUnit validator executes
on the local interpreter. Two cases also execute real isolated pytest suites.
Run: python3 scripts/test-python-pytest-profile.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PROFILE = Path(os.environ.get(
    "RELAY_PROFILE_TEST_SOURCE",
    str(Path(__file__).resolve().parents[1] / "profiles/python-pytest-test-v1.sh"),
)).resolve()

WRAPPER = r'''
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["PROFILE_CALLS"], "a") as stream:
    stream.write(json.dumps(args) + "\n")
fixture = json.loads(pathlib.Path(os.environ["PROFILE_FIXTURE_PATH"]).read_text())
if args == ["-"]:
    sys.version_info = tuple(fixture.get("runtime", [3, 11, 16]))
    exec(compile(sys.stdin.read(), "<actual-profile-runtime-guard>", "exec"))
elif args[:2] == ["-m", "pip"]:
    raise SystemExit(fixture.get("pip_check_exit" if args[2] == "check" else "pip_install_exit", 0))
elif args[:2] == ["-m", "pytest"]:
    if fixture.get("real_pytest"):
        os.execv(os.environ["PROFILE_REAL_PYTHON"], [os.environ["PROFILE_REAL_PYTHON"], *args])
    for arg in args:
        if arg.startswith("--junitxml=") and fixture.get("xml") is not None:
            pathlib.Path(arg.partition("=")[2]).write_bytes(fixture["xml"].encode(fixture.get("xml_encoding", "utf-8")))
    print(fixture.get("summary", "25 passed in 0.01s"))
    raise SystemExit(fixture.get("pytest_exit", 0))
else:
    os.execv(os.environ["PROFILE_REAL_PYTHON"], [os.environ["PROFILE_REAL_PYTHON"], *args])
'''


def report(count=25, *, tests=None, failures="0", errors="0", skipped="0", child=""):
    """Build a provider-result fixture, not a claimed live pytest result."""
    cases = "".join(f'<testcase name="case_{n}">{child}</testcase>' for n in range(count))
    return (f'<testsuites><testsuite tests="{count if tests is None else tests}" '
            f'failures="{failures}" errors="{errors}" skipped="{skipped}">'
            f'{cases}</testsuite></testsuites>')


class ProfileAcceptanceTests(unittest.TestCase):
    def run_profile(self, **fixture):
        """Execute Bash, actual validation, and isolated explicit provider fixtures."""
        with tempfile.TemporaryDirectory(prefix="relay-profile-test-") as temp:
            root = Path(temp)
            binary, work, scratch = root / "bin", root / "work", root / "temporary"
            binary.mkdir(); work.mkdir(); scratch.mkdir()
            wrapper = binary / "python"
            wrapper.write_text(f"#!{sys.executable} -S\n" + WRAPPER)
            wrapper.chmod(0o700)
            fixture.setdefault("xml", report())
            if fixture.get("real_pytest"):
                tests = work / "tests"
                tests.mkdir()
                (tests / "test_generated.py").write_text(
                    "import pytest\n"
                    f"@pytest.mark.parametrize('value', range({fixture['count']}))\n"
                    "def test_positive(value):\n    assert value >= 0\n"
                )
            calls = root / "calls.jsonl"
            fixture_path = root / "fixture.json"
            fixture_path.write_text(json.dumps(fixture))
            env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ.get("PATH", ""),
                   "TMPDIR": str(scratch), "PROFILE_CALLS": str(calls),
                   "PROFILE_FIXTURE_PATH": str(fixture_path), "PROFILE_REAL_PYTHON": sys.executable,
                   "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
            result = subprocess.run(["bash", str(PROFILE)], cwd=work, env=env,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(list(scratch.iterdir()), [], "profile result files must be cleaned")
            return result, [json.loads(line) for line in calls.read_text().splitlines()]

    def test_historical_25_tests_pass(self):
        """Accept the formerly required suite size without a count-specific rule."""
        result, _ = self.run_profile()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_larger_successful_suite_passes(self):
        """Accept a larger suite when every reported case passes."""
        result, _ = self.run_profile(xml=report(37), summary="37 passed in 0.35s")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_both_frozen_runtime_versions_are_accepted(self):
        """Exercise the unchanged runtime guard with both authorized version fixtures."""
        for runtime in ([3, 11, 16], [3, 12, 14]):
            with self.subTest(runtime=runtime):
                result, _ = self.run_profile(runtime=runtime)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_unapproved_runtime_stops_before_installation(self):
        """Reject an unauthorized runtime before any installation is attempted."""
        result, calls = self.run_profile(runtime=[3, 11, 15])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [["-"]])

    def test_install_failure_cannot_be_hidden(self):
        """Propagate installation failure without executing pytest."""
        result, calls = self.run_profile(pip_install_exit=42)
        self.assertEqual(result.returncode, 42)
        self.assertFalse(any(call[:2] == ["-m", "pytest"] for call in calls))

    def test_dependency_check_failure_cannot_be_hidden(self):
        """Propagate dependency-check failure without executing pytest."""
        result, calls = self.run_profile(pip_check_exit=43)
        self.assertEqual(result.returncode, 43)
        self.assertFalse(any(call[:2] == ["-m", "pytest"] for call in calls))

    def test_pytest_failure_cannot_be_hidden_by_passing_evidence(self):
        """Reject a failed pytest process even when its report claims success."""
        result, _ = self.run_profile(pytest_exit=1)
        self.assertEqual(result.returncode, 1)

    def test_no_tests_exit_cannot_be_hidden(self):
        """Preserve the pytest no-tests-collected failure exit."""
        result, _ = self.run_profile(pytest_exit=5)
        self.assertEqual(result.returncode, 5)

    def test_missing_result_rejects_passing_console_output(self):
        """Require a real result document rather than a passing console message."""
        result, _ = self.run_profile(xml=None)
        self.assertNotEqual(result.returncode, 0)

    def test_malformed_result_rejects_passing_console_output(self):
        """Reject invalid XML even when console output reports success."""
        result, _ = self.run_profile(xml="<broken")
        self.assertNotEqual(result.returncode, 0)

    def test_zero_tests_are_not_success(self):
        """Reject empty suites instead of accepting vacuous success."""
        result, _ = self.run_profile(xml=report(0))
        self.assertNotEqual(result.returncode, 0)

    def test_false_reported_count_is_rejected(self):
        """Require reported totals to equal the actual testcase inventory."""
        result, _ = self.run_profile(xml=report(25, tests="26"))
        self.assertNotEqual(result.returncode, 0)

    def test_failure_count_is_rejected(self):
        """Reject any reported test failure."""
        result, _ = self.run_profile(xml=report(failures="1"))
        self.assertNotEqual(result.returncode, 0)

    def test_error_count_is_rejected(self):
        """Reject any reported test error."""
        result, _ = self.run_profile(xml=report(errors="1"))
        self.assertNotEqual(result.returncode, 0)

    def test_skip_count_is_rejected(self):
        """Preserve the zero-skips acceptance policy."""
        result, _ = self.run_profile(xml=report(skipped="25"))
        self.assertNotEqual(result.returncode, 0)

    def test_bad_numeric_counters_are_rejected(self):
        """Require canonical nonnegative integer counter representations."""
        for value in ("True", "-1", "1.0", "", "01"):
            with self.subTest(value=value):
                result, _ = self.run_profile(xml=report(tests=value))
                self.assertNotEqual(result.returncode, 0)

    def test_unreported_nonpassing_cases_are_rejected(self):
        """Reject failed, errored, or skipped cases hidden by zero counters."""
        for child in ("<failure/>", "<error/>", "<skipped/>"):
            with self.subTest(child=child):
                result, _ = self.run_profile(xml=report(child=child))
                self.assertNotEqual(result.returncode, 0)

    def test_unexpected_root_is_rejected(self):
        """Reject XML documents outside the supported JUnit root shapes."""
        result, _ = self.run_profile(xml="<not-a-report/>")
        self.assertNotEqual(result.returncode, 0)

    def test_nested_suite_cannot_hide_evidence(self):
        """Reject nested suites instead of silently ignoring their results."""
        xml = report().replace("</testsuite>", '<testsuite tests="1"/></testsuite>')
        result, _ = self.run_profile(xml=xml)
        self.assertNotEqual(result.returncode, 0)

    def test_doctype_is_rejected(self):
        """Reject DTD declarations before parsing result XML."""
        result, _ = self.run_profile(xml='<!DOCTYPE testsuites []>' + report())
        self.assertNotEqual(result.returncode, 0)

    def test_oversized_evidence_is_rejected(self):
        """Enforce the bounded result-document size."""
        result, _ = self.run_profile(xml=report() + " " * 2_000_001)
        self.assertNotEqual(result.returncode, 0)

    def test_utf16_doctype_is_rejected(self):
        """Reject alternate encodings that could obscure unsafe declarations."""
        result, _ = self.run_profile(xml='<!DOCTYPE testsuites []>' + report(), xml_encoding="utf-16")
        self.assertNotEqual(result.returncode, 0)

    def test_missing_counter_is_rejected(self):
        """Require every acceptance counter to be explicitly present."""
        result, _ = self.run_profile(xml=report().replace(' errors="0"', ""))
        self.assertNotEqual(result.returncode, 0)

    def test_single_suite_root_is_supported(self):
        """Accept a positive all-passing report with a direct testsuite root."""
        xml = report().removeprefix("<testsuites>").removesuffix("</testsuites>")
        result, _ = self.run_profile(xml=xml)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_multiple_suites_count_actual_cases(self):
        """Count all direct suites and report their combined passing inventory."""
        parts = [report(n).removeprefix("<testsuites>").removesuffix("</testsuites>") for n in (25, 37)]
        result, _ = self.run_profile(xml="<testsuites>" + "".join(parts) + "</testsuites>")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("62 passed", result.stdout)

    def test_real_25_case_pytest_suite(self):
        """Execute a real isolated 25-case suite on the local interpreter."""
        result, _ = self.run_profile(real_pytest=True, count=25)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("25 passed", result.stdout)

    def test_real_37_case_pytest_suite(self):
        """Execute a real larger suite that failed the historical profile rule."""
        result, _ = self.run_profile(real_pytest=True, count=37)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("37 passed", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
