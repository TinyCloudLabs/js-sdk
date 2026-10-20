import { expect, test } from "bun:test";

test("operations root keeps registry-keyed invocation as its only public runtime helper", async () => {
  const operations = await import("./index.js");
  expect(Object.keys(operations)).toEqual(["invokeOperation"]);
});

test("state exposes only lock-owning primitives, never the lock-assuming writer", async () => {
  const state = await import("./state.js");
  expect("updateProfileStore" in state).toBe(true);
  expect("updateProfileStoreWhileLocked" in state).toBe(false);
});

