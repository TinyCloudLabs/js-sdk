import { describe, expect, test } from "bun:test";
import type { KvClient } from "../src/contracts/client";
import { listHasOmission, replicationBound } from "../src/scenarios/core/shared";

describe("core review assertion behavior", () => {
  test("replicationBound explicitly overrides SDK immediate-read staleness", () => {
    expect(replicationBound({ kind: "sdk" } as KvClient, 60_000)).toEqual({ replication: { maxStalenessMs: 60_000 } });
    expect(replicationBound({ kind: "cli" } as KvClient, 60_000)).toEqual({ replication: { maxStalenessMs: 60_000 } });
  });

  test("list omission requires returned keys to be present", () => {
    expect(listHasOmission(undefined, "notes/b")).toBe(false);
    expect(listHasOmission([], "notes/b")).toBe(true);
    expect(listHasOmission(["notes/b"], "notes/b")).toBe(false);
  });
});
