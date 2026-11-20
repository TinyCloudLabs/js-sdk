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


def discover(root):
    groups = {
        "contracts": CONTRACT_TESTS + CHECKS,
        "courier": sorted(str(p.relative_to(root)) for pattern in ("*.test.mjs", "*.test.ts")
                          for p in (root / "packages/courier/test").glob(pattern)),
        "packed-cli": ["tests/packed-runtime/cli.test.ts"],
        "entrypoints": ["tests/packed-runtime/entrypoints.test.ts"],
    }
    for shard, files in groups.items():
        if not files:
            raise ValueError(f"Empty I0 shard: {shard}")
        for file in files:
            if not (root / file).is_file():
                raise ValueError(f"Missing I0 input: {file}")
    return groups


def relative_file(file, root):
    path = Path(file)
    return str((path if path.is_absolute() else root / path).resolve().relative_to(root))


def bun_executed_files(report, root):
    return sorted({relative_file(case.attrib["file"], root)
                   for case in ET.parse(report).iter("testcase")})


def node_executed_files(report, root):
    return sorted({relative_file(json.loads(line)["file"], root)
                   for line in report.read_text().splitlines() if line.strip()})


def validate_coverage(expected, reports):
    if set(expected) != set(reports):
        raise ValueError(f"I0 shard reports differ: missing={set(expected) - set(reports)}, extra={set(reports) - set(expected)}")
    for shard, files in expected.items():
        actual = reports[shard]
        missing, extra = set(files) - set(actual), set(actual) - set(files)
        if missing or extra or len(actual) != len(set(actual)):
            raise ValueError(f"I0 {shard}: missing={sorted(missing)}, extra={sorted(extra)}, duplicate={len(actual) != len(set(actual))}")
    flattened = [file for files in reports.values() for file in files]
    if len(flattened) != len(set(flattened)):
        raise ValueError("I0 test files executed in more than one shard")


def run_shard(shard, output):
    expected = discover(ROOT)[shard]
    output.mkdir(parents=True, exist_ok=True)
    executed = []

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
        executed.extend(bun_executed_files(report, ROOT))

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
    validate_coverage({shard: expected}, {shard: executed})
    (output / f"{shard}.json").write_text(json.dumps(executed, indent=2) + "\n")


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
        validate_coverage(expected, reports)
        print(f"I0 shard coverage: all {sum(map(len, expected.values()))} test files/checks executed exactly once across {len(SHARDS)} shards")
    else:
        raise ValueError(f"Unknown I0 command: {command}")


if __name__ == "__main__":
    main()
