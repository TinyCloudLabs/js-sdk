import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { REGISTRY_SOURCE_SHA256, REGISTRY_VERSION } from "./capabilities";

// Pins the identity of the vendored tinycloud-node registry (TC-112). If the
// generated file is re-vendored from a different node rev, these constants
// change and this test fails — forcing a deliberate update here AND in the
// capabilities-sync workflow's FALLBACK_NODE_REV, so the two can't silently
// diverge. Once codegen emits REGISTRY_SOURCE_GIT_SHA, the workflow reads the
// rev straight from the header and the FALLBACK_NODE_REV coupling below can go.
const EXPECTED_VERSION = 1;
const EXPECTED_SOURCE_SHA256 =
  "3850f17a9771600b4a0f7bfa38ccaed8464f3ee391342f5d5b627276e614a8ff";
const EXPECTED_NODE_REV = "e9be8963aef608b2e7cd61df500c84a6104df62a";

const WORKFLOW = join(
  import.meta.dir,
  "../../../../.github/workflows/capabilities-sync.yml",
);

test("vendored registry identity is pinned", () => {
  expect(REGISTRY_VERSION).toBe(EXPECTED_VERSION);
  expect(REGISTRY_SOURCE_SHA256).toBe(EXPECTED_SOURCE_SHA256);
});

test("capabilities-sync FALLBACK_NODE_REV matches the pinned node rev", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const match = yaml.match(/FALLBACK_NODE_REV:\s*([0-9a-f]{40})/);
  expect(match).not.toBeNull();
  expect(match![1]).toBe(EXPECTED_NODE_REV);
});
