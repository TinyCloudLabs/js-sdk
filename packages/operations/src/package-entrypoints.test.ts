import { expect, test } from "bun:test";

test("state exposes only lock-owning primitives, never the lock-assuming writer", async () => {
  const state = await import("./state.js");
  expect("updateProfileStore" in state).toBe(true);
  expect("updateProfileStoreWhileLocked" in state).toBe(false);
});

test("operations root keeps registry-keyed invocation as its only public runtime helper", async () => {
  const root = await import("./index.js");
  expect(Object.keys(root)).toEqual(["invokeOperation"]);
});
