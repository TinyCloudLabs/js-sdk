import { expect, test } from "bun:test";

import { verifyPackedTinyCloudEntrypoints } from "./tinycloud-entrypoints.ts";

test("independently packed SDK and Operations entrypoints work in Node 18 CJS and ESM", async () => {
  await verifyPackedTinyCloudEntrypoints();
  expect(true).toBe(true);
  // The clean archive rebuilds the Rust WASM input and every published package;
  // allow a loaded host more than two minutes while keeping the probe bounded.
}, 180_000);
