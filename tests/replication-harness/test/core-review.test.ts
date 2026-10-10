import { describe, expect, test } from "bun:test";
import type { KvClient } from "../src/contracts/client";
import { listHasOmission, replicationBound } from "../src/scenarios/core/shared";
import { core04 } from "../src/scenarios/core/core-04";

describe("core review assertion behavior", () => {
  test("per-call replication bounds apply only to CLI clients", () => {
    expect(replicationBound({ kind: "sdk" } as KvClient, 60_000)).toEqual({});
    expect(replicationBound({ kind: "cli" } as KvClient, 60_000)).toEqual({ replication: { maxStalenessMs: 60_000 } });
  });

  test("SDK freshness experiment is configured through its ReplicationSpec", () => {
    const sdkReader = core04.topology("cli>sdk", "sqlite").clients.find((client) => client.id === "r");
    expect(sdkReader?.replication).toMatchObject({ maxStalenessMs: 60_000 });
  });

  test("list omission requires returned keys to be present", () => {
    expect(listHasOmission(undefined, "notes/b")).toBe(false);
    expect(listHasOmission([], "notes/b")).toBe(true);
    expect(listHasOmission(["notes/b"], "notes/b")).toBe(false);
  });
});
