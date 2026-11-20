#!/usr/bin/env python3
"""Run the complete I0 gate in measured file groups; verify runner-observed coverage."""
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SHARDS = ("contracts", "courier", "packed-cli", "entrypoints")
# Same focused boundary as the original serial gate, not the entire SDK test tree.
CONTRACT_TESTS = [
    "packages/cli/src/commands/secrets.test.ts",
    "packages/cli/src/commands/secrets-owner-retry.test.ts",
    "packages/cli/src/commands/auth.test.ts",
    "packages/cli/src/auth/device-auth.test.ts",
    "packages/cli/src/lib/sdk-bootstrap.test.ts",
    "packages/cli/src/config/profiles.test.ts",
    "packages/cli/src/auth/scoped-login.test.ts",
    "packages/cli/src/commands/context.test.ts",
    "packages/cli/src/commands/courier.test.ts",
    "packages/cli/src/lib/permissions.test.ts",
    "packages/cli/src/output/errors.test.ts",
    "tests/mcp-sdk-contract/contract.test.ts",
    "tests/mcp-sdk-contract/prerequisites.test.ts",
]
CHECKS = [
    "packages/cli/scripts/check-skill-pack.mjs",
    "tests/mcp-sdk-contract/scripts/verify-packed-public-api.ts",
]
# These two entire files were already opt-in/skip-only in the serial gate.
# Keep them visible as SKIPPED, never count them as executed, and fail if they
# disappear or start running so this exception cannot silently become stale.
KNOWN_SKIP_ONLY = [
    "packages/courier/test/interim-local.test.mjs",
    "packages/courier/test/revoke-issued-local.test.mjs",
]


def discover(root):
    groups = {
        "contracts": CONTRACT_TESTS + CHECKS,
        "courier": sorted(str(p.relative_to(root)) for pattern in ("*.test.mjs", "*.test.ts")
                          for p in (root / "packages/courier/test").glob(pattern)),
        "packed-cli": ["tests/packed-runtime/cli.test.ts"],
        "entrypoints": ["tests/packed-runtime/entrypoints.test.ts"],
    }
    if not set(KNOWN_SKIP_ONLY).issubset(groups["courier"]):
        raise ValueError("Known skip-only I0 files disappeared; review the exception")
    for shard, files in groups.items():
        if not files:
            raise ValueError(f"Empty I0 shard: {shard}")
        for file in files:
            if not (root / file).is_file():
                raise ValueError(f"Missing I0 input: {file}")
    return groups


def relative_file(file, root, cwd=None):
    path = Path(file)
    return str((path if path.is_absolute() else (cwd or root) / path).resolve().relative_to(root))


def bun_executed_files(report, root, cwd=None):
    return sorted({relative_file(case.attrib["file"], root, cwd)
                   for case in ET.parse(report).iter("testcase") if case.find("skipped") is None})


def node_executed_files(report, root):
    return sorted({relative_file(event["file"], root)
                   for event in map(json.loads, report.read_text().splitlines()) if not event["skipped"]})


def node_skipped_files(report, root):
    return sorted({relative_file(event["file"], root)
                   for event in map(json.loads, report.read_text().splitlines()) if event["skipped"]})


def validate_coverage(expected, reports, skipped=None, known_skips=()):
    skipped = skipped if skipped is not None else {shard: [] for shard in expected}
    if set(expected) != set(reports) or set(expected) != set(skipped):
        raise ValueError(f"I0 shard reports differ: expected={sorted(expected)}, actual={sorted(reports)}, skipped={sorted(skipped)}")
    if not set(known_skips).issubset(file for files in expected.values() for file in files):
        raise ValueError("Known skip-only I0 files disappeared; review the exception")
    for shard, files in expected.items():
        actual = reports[shard]
        expected_skips = set(files) & set(known_skips)
        missing, extra = set(files) - expected_skips - set(actual), set(actual) - (set(files) - expected_skips)
        if missing or extra or len(actual) != len(set(actual)):
            raise ValueError(f"I0 {shard}: missing={sorted(missing)}, extra={sorted(extra)}, duplicate={len(actual) != len(set(actual))}")
        if set(skipped[shard]) != expected_skips or len(skipped[shard]) != len(expected_skips):
            raise ValueError(f"I0 {shard}: skip-only evidence differs: expected={sorted(expected_skips)}, actual={skipped[shard]}")
    flattened = [file for files in reports.values() for file in files]
    if len(flattened) != len(set(flattened)):
        raise ValueError("I0 test files executed in more than one shard")


def run_shard(shard, output):
    expected = discover(ROOT)[shard]
    output.mkdir(parents=True, exist_ok=True)
    executed = []
    skipped = []

    def run(command, cwd=ROOT):
        print(f"::group::{subprocess.list2cmdline(command)}", flush=True)
        try:
            subprocess.run(["bash", str(ROOT / ".github/scripts/run-private-tests.sh"), *command], cwd=cwd, check=True)
        finally:
            print("::endgroup::", flush=True)

    def bun_tests(files, cwd=ROOT):
        report = output / f"bun-{len(executed)}.xml"
        run(["bun", "test", *["./" + str((ROOT / file).relative_to(cwd)) for file in files],
             "--reporter=junit", f"--reporter-outfile={report}"], cwd)
        executed.extend(bun_executed_files(report, ROOT, cwd))

    if shard == "courier":
        courier = ROOT / "packages/courier"
        # Preserve the package test script's compiler check, Node setup/timeout,
        # and Bun pass. Expand its two globs so new Courier files join the gate.
        run(["bun", "run", "build"], courier)
        report = output / "node.jsonl"
        run(["node", "--import", "./test/setup-home.mjs", "--test", "--test-timeout=120000",
             "--test-reporter=tap", "--test-reporter-destination=stdout",
             f"--test-reporter={ROOT / '.github/scripts/i0-node-reporter.mjs'}",
             f"--test-reporter-destination={report}",
             *["./" + str((ROOT / file).relative_to(courier)) for file in expected if file.endswith(".mjs")]], courier)
        executed.extend(node_executed_files(report, ROOT))
        skipped.extend(sorted(set(node_skipped_files(report, ROOT)) - set(executed)))
        bun_tests([file for file in expected if file.endswith(".ts")], courier)
    else:
        # Keep one private HOME/process per focused Bun suite (global mocks must
        # not leak between CLI and MCP files).
        for file in expected:
            if file not in CHECKS:
                bun_tests([file])
        if shard == "contracts":
            run(["bun", "run", "--cwd", "packages/cli", "check:skill-pack"])
            executed.append(CHECKS[0])
            run(["bun", "run", "--cwd", "tests/mcp-sdk-contract", "test:public-api"])
            executed.append(CHECKS[1])
    known = sorted(set(expected) & set(KNOWN_SKIP_ONLY))
    validate_coverage({shard: expected}, {shard: executed}, {shard: skipped}, known)
    (output / f"{shard}.json").write_text(json.dumps({"executed": executed, "skipped": skipped}, indent=2) + "\n")


def main():
    command, argument = sys.argv[1:]
    if command == "run":
        if argument not in SHARDS:
            raise ValueError(f"Unknown I0 shard: {argument}")
        run_shard(argument, (ROOT / ".i0-coverage" / argument).resolve())
    elif command == "verify":
        directory = Path(argument)
        expected = discover(ROOT)
        reports = {shard: json.loads((directory / f"{shard}.json").read_text()) for shard in SHARDS}
        executed = {shard: report["executed"] for shard, report in reports.items()}
        skipped = {shard: report["skipped"] for shard, report in reports.items()}
        validate_coverage(expected, executed, skipped, KNOWN_SKIP_ONLY)
        print(f"I0 shard coverage: {sum(map(len, executed.values()))} test files/checks EXECUTED exactly once across {len(SHARDS)} shards")
        for file in KNOWN_SKIP_ONLY:
            print(f"SKIPPED (existing opt-in live-node file; runner-confirmed): {file}")
    else:
        raise ValueError(f"Unknown I0 command: {command}")


if __name__ == "__main__":
    main()
