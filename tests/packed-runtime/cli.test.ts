import { test } from "bun:test";

import {
  verifyMissingTrackedCliArtifactCannotBeMasked,
  verifyPackedCliRuntime,
} from "./cli.ts";

test("clean packed CLI runtime routes associated and unmatched auth imports", async () => {
  await verifyPackedCliRuntime();
}, 600_000);

test("a missing tracked CLI artifact cannot be masked by a prior worktree build", async () => {
  await verifyMissingTrackedCliArtifactCannotBeMasked();
}, 120_000);
