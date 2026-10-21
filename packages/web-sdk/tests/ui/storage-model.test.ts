import { describe, expect, test } from "bun:test";

import { storageModel } from "../../src/ui/storage-state";

const known = (state: "ok" | "nearly_full" | "full", usedBytes: number, limitBytes: number) =>
  ({ kind: "known" as const, state, usedBytes, limitBytes });

describe("storageModel", () => {
  test("known ok shows the state word and the used-of-limit numbers with a bar", () => {
    expect(storageModel(known("ok", 250, 1000), false)).toEqual({
      wordKey: "storage.state.ok",
      usage: { key: "storage.usage.known", usedBytes: 250, limitBytes: 1000, percent: 25 },
    });
  });

  test("bar fill is clamped to 100 when usage is over the limit", () => {
    expect(storageModel(known("full", 1500, 1000), false).usage?.percent).toBe(100);
  });

  test("a zero limit fills the bar rather than dividing by zero", () => {
    expect(storageModel(known("full", 0, 0), false).usage?.percent).toBe(100);
  });

  test("unlimited shows usage with no bar and no percent", () => {
    expect(storageModel({ kind: "unlimited", usedBytes: 42 }, false)).toEqual({
      wordKey: "storage.state.unlimited",
      usage: { key: "storage.usage.unlimited", usedBytes: 42 },
    });
  });

  test("needs permission asks for permission and shows no numbers", () => {
    expect(storageModel({ kind: "needs_permission" }, false)).toEqual({
      noteKey: "storage.permission",
      action: "allow",
    });
  });

  test("declined offers a try-again and shows no numbers", () => {
    expect(storageModel({ kind: "declined" }, false)).toEqual({
      noteKey: "storage.declined",
      action: "try_again",
    });
  });

  test("unavailable is a note with no action", () => {
    expect(storageModel({ kind: "unavailable" }, false)).toEqual({ noteKey: "storage.unavailable" });
  });

  test("a known error code maps to its own note and offers retry", () => {
    expect(storageModel({ kind: "error", code: "NETWORK_ERROR" }, false)).toEqual({
      noteKey: "storage.error.network",
      action: "retry",
    });
  });

  test("an unknown error code gets the generic note, never the raw code", () => {
    expect(storageModel({ kind: "error", code: "SOMETHING_NEW" }, false)).toEqual({
      noteKey: "storage.error.generic",
      action: "retry",
    });
  });

  test("signed out renders nothing even while an episode is on", () => {
    expect(storageModel({ kind: "signed_out" }, true)).toEqual({});
  });

  test("an episode says full and drops numbers even when status says ok", () => {
    expect(storageModel(known("ok", 250, 1000), true)).toEqual({ wordKey: "storage.state.full" });
  });

  test("an episode during a loading read still says full", () => {
    expect(storageModel({ kind: "loading" }, true)).toEqual({ wordKey: "storage.state.full" });
  });

  test("an episode keeps a failed read's note and retry so the user can still act", () => {
    expect(storageModel({ kind: "error", code: "NETWORK_ERROR" }, true)).toEqual({
      wordKey: "storage.state.full",
      noteKey: "storage.error.network",
      action: "retry",
    });
  });
});
