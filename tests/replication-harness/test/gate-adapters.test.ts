import { describe, expect, test } from "bun:test";
import type { RunEnvironment } from "../src/contracts/lifecycle";
import type { RunInputs } from "../src/contracts/gate";
import { assertLegSutMatches } from "../bin/gate-adapters";

const sut = {
  source: "workspace" as const,
  gitSha: "a".repeat(40),
  distSha256: "b".repeat(64),
  cli: { version: "1.0.0", packageJson: "/resolve/cli/package.json", entry: "/resolve/cli/index.js" },
  nodeSdk: { version: "1.0.0", packageJson: "/resolve/sdk/package.json", entry: "file:///resolve/sdk/index.js", condition: "import" as const },
};

describe("gate leg SUT identity", () => {
  test("rejects a workspace build digest that differs from resolve", () => {
    const expected = sut as RunInputs["sut"];
    const actual = { ...sut, root: "/leg", distSha256: "c".repeat(64) } as RunEnvironment["sut"];
    expect(() => assertLegSutMatches(expected, actual)).toThrow("SUT_DIST_SHA256_MISMATCH");
  });
});
