import { expect, test } from "bun:test";

import { verifyPackedTinyCloudEntrypoints } from "./tinycloud-entrypoints.ts";

test("independently packed SDK and Operations entrypoints work in Node 20 CJS and ESM", async () => {
  await verifyPackedTinyCloudEntrypoints();
  expect(true).toBe(true);
  // A clean exact archive may compile the Rust WASM input and every published
  // package in the isolated tree. Reuse valid outputs there, but allow a cold
  // runner a bounded nine-minute window.
}, 540_000);
