import { expect, test } from "bun:test";

test("state exposes only lock-owning primitives, never the lock-assuming writer", async () => {
  const state = await import("./state.js");
  expect("updateProfileStore" in state).toBe(true);
  expect("updateProfileStoreWhileLocked" in state).toBe(false);
});
