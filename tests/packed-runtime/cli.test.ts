import { test } from "bun:test";

import { verifyPackedCliRuntime } from "./cli.ts";

test("clean packed CLI runtime routes associated and unmatched auth imports", async () => {
  await verifyPackedCliRuntime();
}, 120_000);
