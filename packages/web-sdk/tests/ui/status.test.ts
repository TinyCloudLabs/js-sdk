import { describe, expect, test } from "bun:test";

import { createStatusBoard, highestStatus, syncStatus } from "../../src/ui/status";

describe("syncStatus", () => {
  test("pending always raises sync_pending", () => {
    expect(syncStatus("pending", false)).toBe("sync_pending");
    expect(syncStatus("pending", true)).toBe("sync_pending");
  });

  test("unavailable raises sync_attention only when requested", () => {
    expect(syncStatus("unavailable", true)).toBe("sync_attention");
    expect(syncStatus("unavailable", false)).toBeNull();
  });

  test("other states raise nothing", () => {
    for (const effective of ["off", "enabling", "on", "wiping"]) {
      expect(syncStatus(effective, true)).toBeNull();
    }
  });

  test("unknown effective is treated as unavailable", () => {
    expect(syncStatus("something-new", true)).toBe("sync_attention");
    expect(syncStatus("something-new", false)).toBeNull();
  });
});

describe("highestStatus", () => {
  test("storage_full outranks sync_pending outranks sync_attention", () => {
    expect(highestStatus(["sync_attention", "sync_pending", "storage_full"])).toBe("storage_full");
    expect(highestStatus([null, "sync_attention", "sync_pending"])).toBe("sync_pending");
  });

  test("null when nothing is set", () => {
    expect(highestStatus([null, null])).toBeNull();
  });
});

describe("createStatusBoard", () => {
  test("reports the highest-priority source and notifies only on change", () => {
    const seen: Array<string | null> = [];
    const board = createStatusBoard((top) => seen.push(top));

    board.set("sync", "sync_attention");
    board.set("storage", "storage_full");
    board.set("sync", "sync_pending"); // still below storage_full: top unchanged
    board.set("storage", null);
    board.set("sync", null);

    expect(seen).toEqual(["sync_attention", "storage_full", "sync_pending", null]);
    expect(board.top()).toBeNull();
  });

  test("setting the same status twice does not notify", () => {
    const seen: Array<string | null> = [];
    const board = createStatusBoard((top) => seen.push(top));
    board.set("sync", "sync_pending");
    board.set("sync", "sync_pending");
    expect(seen).toEqual(["sync_pending"]);
  });
});
