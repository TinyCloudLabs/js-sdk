import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  REGISTRY_SOURCE_GIT_SHA,
  REGISTRY_SOURCE_REPO,
  REGISTRY_SOURCE_SHA256,
  REGISTRY_VERSION,
} from "./capabilities";

// Pins the identity of the vendored tinycloud-node registry (TC-112). If the
// generated file is re-vendored from a different node rev, these constants
// change and this test fails — forcing a deliberate update here AND in the
// capabilities-sync workflow's ANCHOR_NODE_REV, so the two can't silently
// diverge. ANCHOR_NODE_REV is the authoritative diff anchor (the commit the
// artifact was vendored at); the header's REGISTRY_SOURCE_GIT_SHA is NOT used as
// the anchor because, for a locally-generated artifact, it names the generation
// parent rather than the commit the file lives at (see the workflow comments).
const EXPECTED_VERSION = 1;
const EXPECTED_SOURCE_SHA256 =
  "3850f17a9771600b4a0f7bfa38ccaed8464f3ee391342f5d5b627276e614a8ff";
// tinycloud-node release tag v1.4.5.
const EXPECTED_NODE_REV = "a20b48f14ccb56eb849c60529a28b5657765faef";

const WORKFLOW = join(
  import.meta.dir,
  "../../../../.github/workflows/capabilities-sync.yml",
);

test("vendored registry identity is pinned", () => {
  expect(REGISTRY_VERSION).toBe(EXPECTED_VERSION);
  expect(REGISTRY_SOURCE_SHA256).toBe(EXPECTED_SOURCE_SHA256);
});

test("vendored registry carries TC-121 source headers", () => {
  expect(REGISTRY_SOURCE_REPO).toBe("TinyCloudLabs/tinycloud-node");
  // The git sha is the artifact's generation source; its exact value is not
  // pinned here (locally-generated artifacts stamp the generation parent), only
  // that a well-formed 40-hex commit sha is present.
  expect(REGISTRY_SOURCE_GIT_SHA).toMatch(/^[0-9a-f]{40}$/);
});

test("capabilities-sync ANCHOR_NODE_REV matches the pinned node rev", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const match = yaml.match(/ANCHOR_NODE_REV:\s*([0-9a-f]{40})/);
  expect(match).not.toBeNull();
  expect(match![1]).toBe(EXPECTED_NODE_REV);
});
