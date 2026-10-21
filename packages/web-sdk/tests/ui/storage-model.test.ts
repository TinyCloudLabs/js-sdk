import { describe, expect, test } from "bun:test";

import { storageModel } from "../../src/ui/storage-state";

const known = (state: "ok" | "nearly_full" | "full", usedBytes: number, limitBytes: number) =>
  ({ kind: "known" as const, state, usedBytes, limitBytes });

describe("storageModel", () => {
  test("known ok shows the state word and the used-of-limit numbers with a bar", () => {
    expect(storageModel(known("ok", 250, 1000), false, true)).toEqual({
      wordKey: "storage.state.ok",
      usage: { key: "storage.usage.known", usedBytes: 250, limitBytes: 1000, percent: 25 },
    });
  });

  test("bar fill is clamped to 100 when usage is over the limit", () => {
    expect(storageModel(known("full", 1500, 1000), false, true).usage?.percent).toBe(100);
  });

  test("a zero limit fills the bar rather than dividing by zero", () => {
    expect(storageModel(known("full", 0, 0), false, true).usage?.percent).toBe(100);
  });

  test("unlimited shows usage with no bar and no percent", () => {
    expect(storageModel({ kind: "unlimited", usedBytes: 42 }, false, true)).toEqual({
      wordKey: "storage.state.unlimited",
      usage: { key: "storage.usage.unlimited", usedBytes: 42 },
    });
  });

  test("needs permission offers Allow when the client can ask for authority", () => {
    expect(storageModel({ kind: "needs_permission" }, false, true)).toEqual({
      noteKey: "storage.permission",
      action: "allow",
    });
  });

  test("needs permission with no authority request states the need and offers no action", () => {
    expect(storageModel({ kind: "needs_permission" }, false, false)).toEqual({
      noteKey: "storage.permission",
    });
  });

  test("declined offers a try-again and shows no numbers", () => {
    expect(storageModel({ kind: "declined" }, false, true)).toEqual({
      noteKey: "storage.declined",
      action: "try_again",
    });
  });

  test("unavailable is a note with no action", () => {
    expect(storageModel({ kind: "unavailable" }, false, true)).toEqual({ noteKey: "storage.unavailable" });
  });

  test("a known error code maps to its own note and offers retry", () => {
    expect(storageModel({ kind: "error", code: "NETWORK_ERROR" }, false, true)).toEqual({
      noteKey: "storage.error.network",
      action: "retry",
    });
  });

  test("an unknown error code gets the generic note, never the raw code", () => {
    expect(storageModel({ kind: "error", code: "SOMETHING_NEW" }, false, true)).toEqual({
      noteKey: "storage.error.generic",
      action: "retry",
    });
  });

  test("signed out renders nothing even while an episode is on", () => {
    expect(storageModel({ kind: "signed_out" }, true, true)).toEqual({});
  });

  test("an episode says full and drops numbers even when status says ok", () => {
    expect(storageModel(known("ok", 250, 1000), true, true)).toEqual({ wordKey: "storage.state.full" });
  });

  test("an episode during a loading read still says full", () => {
    expect(storageModel({ kind: "loading" }, true, true)).toEqual({ wordKey: "storage.state.full" });
  });

  test("an episode keeps a failed read's note and retry so the user can still act", () => {
    expect(storageModel({ kind: "error", code: "NETWORK_ERROR" }, true, true)).toEqual({
      wordKey: "storage.state.full",
      noteKey: "storage.error.network",
      action: "retry",
    });
  });
});
