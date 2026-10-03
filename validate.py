#!/usr/bin/env python3
"""
Runs the checks of the project on the command line and prints their output:

  node        'node --check' on every JavaScript file of the webclient (syntax)
  eslint      ESLint, configured in eslint.config.mjs
  typescript  the TypeScript checker on the JavaScript files, configured in tsconfig.json
  lines       text files must use LF line endings (.gitattributes, .editorconfig)
  tests       pytest

Usage:  python validate.py [check ...] [--quiet]
Without names all checks run. The exit code is 0 when every check that ran passed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEBCLIENT = ROOT / "src" / "timelens" / "webclient"


class Result:
    def __init__(self, name, ok, output="", note="", seconds=0.0):
        self.name = name
        self.ok = ok            # True, False, or None when the check was skipped
        self.output = output
        self.note = note
        self.seconds = seconds


def tool(name):
    """A tool installed with npm: node_modules/.bin/<name>, or None."""
    suffix = ".cmd" if os.name == "nt" else ""
    path = ROOT / "node_modules" / ".bin" / f"{name}{suffix}"
    return str(path) if path.is_file() else None


def run(command):
    """Runs a command in the project folder, returns (exit code, stdout and stderr)."""
    process = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, encoding="utf8", errors="replace")
    return process.returncode, (process.stdout + process.stderr).strip()


def check_node():
    node = shutil.which("node")
    if node is None:
        return Result("node", None, note="node is not installed")

    files = sorted(WEBCLIENT.glob("*.js"))
    failures = []
    for path in files:
        code, output = run([node, "--check", str(path)])
        if code != 0:
            failures.append(output)
    note = f"{len(files)} files"
    return Result("node", not failures, "\n\n".join(failures), note)


def check_eslint():
    eslint = tool("eslint")
    if eslint is None:
        return Result("eslint", None, note="eslint is not installed, run 'npm install'")

    code, output = run([eslint, "."])
    return Result("eslint", code == 0, output)


def check_typescript():
    tsc = tool("tsc")
    if tsc is None:
        return Result("typescript", None, note="typescript is not installed, run 'npm install'")

    code, output = run([tsc, "--noEmit", "--pretty", "false", "-p", "tsconfig.json"])
    errors = sum(1 for line in output.splitlines() if ": error TS" in line)
    return Result("typescript", code == 0, output, f"{errors} errors" if errors else "")


def check_line_endings():
    git = shutil.which("git")
    if git is None:
        return Result("lines", None, note="git is not installed")

    # tracked and untracked files, the ones that are ignored are left out
    code, output = run([git, "ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    if code != 0:
        return Result("lines", False, output)

    bad = []
    checked = 0
    for name in output.split("\0"):
        path = ROOT / name
        if not name or not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue    # binary
        checked += 1
        carriage_returns = data.count(b"\r")
        if carriage_returns:
            bad.append(f"{name}: {carriage_returns} CR characters")
    return Result("lines", not bad, "\n".join(bad), f"{checked} files")


def check_tests():
    # only 'tests': src/timelens/*_test.py are manual scripts, not part of the test suite
    code, output = run([sys.executable, "-m", "pytest", "-q", "tests"])
    if "No module named pytest" in output:
        return Result("tests", None, note="pytest is not installed, run 'pip install -e \".[dev]\"'")
    return Result("tests", code == 0, output)


CHECKS = {
    "node": check_node,
    "eslint": check_eslint,
    "typescript": check_typescript,
    "lines": check_line_endings,
    "tests": check_tests,
}


def main():
    parser = argparse.ArgumentParser(description="Runs the checks of the project.")
    parser.add_argument("checks", nargs="*", metavar="check",
                        help=f"one or more of: {', '.join(CHECKS)} (default: all)")
    parser.add_argument("--quiet", action="store_true", help="only print the summary")
    args = parser.parse_args()

    names = args.checks or list(CHECKS)
    unknown = [name for name in names if name not in CHECKS]
    if unknown:
        parser.error(f"unknown check: {', '.join(unknown)} (choose from {', '.join(CHECKS)})")

    results = []
    for name in names:
        print(f"== {name} ...", flush=True)
        started = time.perf_counter()
        result = CHECKS[name]()
        result.seconds = time.perf_counter() - started
        results.append(result)

        if result.output and not args.quiet:
            print(result.output)
        status = "SKIPPED" if result.ok is None else "PASSED" if result.ok else "FAILED"
        print(f"-- {name}: {status}" + (f" ({result.note})" if result.note else "") + f" in {result.seconds:.1f}s\n", flush=True)

    print("Summary")
    for result in results:
        status = "skipped" if result.ok is None else "passed " if result.ok else "FAILED "
        print(f"  {status}  {result.name:<11} {result.note}")

    return 0 if all(result.ok is not False for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
