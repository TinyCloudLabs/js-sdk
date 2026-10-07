import { describe, expect, mock, test } from "bun:test";
import { AccountService, type AccountSpace, type ISpaceService, type Result, ErrorCodes, err, ok, serviceError } from "@tinycloud/sdk-core";
import type { IDatabaseHandle, KVBatchReadResponse, KVResponse } from "@tinycloud/sdk-services";

const ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0xabc:account";
const OWNER_DID = "did:pkh:eip155:1:0xabc";
const names = ["default", "applications", "account", "secrets", "public", "agents"] as const;

function keyFor(name: string): string {
  return `spaces/tinycloud:pkh:eip155:1:0xabc:${name}`;
}

function input(name: string): AccountSpace {
  return {
    spaceId: `tinycloud:pkh:eip155:1:0xabc:${name}`,
    name,
    ownerDid: OWNER_DID,
    type: "owned",
    permissions: ["*"],
    status: "active",
  };
}

function record(name: string, patch: Record<string, unknown> = {}) {
  return {
    space_id: input(name).spaceId,
    name,
    owner_did: OWNER_DID,
    type: "owned",
    permissions: ["*"],
    status: "active",
    registered_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function makeHarness(options: {
  initial?: Map<string, unknown>;
  batchReadResult?: (keys: string[]) => Result<KVBatchReadResponse<Record<string, unknown>>>;
  putImpl?: (key: string, value: unknown, opts?: { ifNoneMatch?: "*" }) => Promise<Result<KVResponse<unknown>>>;
  getImpl?: (key: string) => Promise<Result<KVResponse<Record<string, unknown>>>>;
} = {}) {
  const stored = options.initial ?? new Map<string, unknown>();
  const batchGet = mock(async (keys: string[]) => {
    if (options.batchReadResult) return options.batchReadResult(keys);
    return ok({
      results: keys.map((key) => stored.has(key)
        ? { key, result: ok({ data: stored.get(key), headers: {} }) }
        : { key, result: err(serviceError(ErrorCodes.KV_NOT_FOUND, "Key not found", "kv")) }),
      count: keys.length,
    });
  });
  const put = mock(async (key: string, value: unknown, opts?: { ifNoneMatch?: "*" }) => {
    if (options.putImpl) return options.putImpl(key, value, opts);
    stored.set(key, value);
    return ok({ data: undefined, headers: {} });
  });
  const get = mock(async (key: string) => {
    if (options.getImpl) return options.getImpl(key);
    const value = stored.get(key);
    return value
      ? ok({ data: value, headers: {} })
      : err(serviceError(ErrorCodes.KV_NOT_FOUND, "Key not found", "kv"));
  });
  const batchPut = mock(async () => {
    throw new Error("registerMissing must not call batchPut");
  });
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const dbBatch = mock(async (batch: Array<{ sql: string; params?: unknown[] }>) => {
    statements.push(...batch);
    return ok({ results: batch.map(() => ({ changes: 1, lastInsertRowId: 0 })) });
  });
  const db = {
    migrations: { apply: mock(async () => ok({ database: "account", namespace: "test", status: "already_current", applied: [], skipped: [] })) },
    batch: dbBatch,
    query: mock(async () => ok({ columns: [], rows: [], rowCount: 0 })),
  };
  const ensureAccountSpaceHosted = mock(async () => {});
  const spaceService = {
    list: async () => ok([]),
    get: () => ({
      kv: { batchGet, get, put, batchPut, list: async () => ok({ keys: [] }), delete: async () => ok(undefined) },
      delegations: { list: async () => ok([]), listReceived: async () => ok([]), revoke: async () => ok(undefined) },
    }),
  };
  const service = new AccountService({
    getDid: () => OWNER_DID,
    getHost: () => "https://tinycloud.test",
    getPrimarySpaceId: () => input("default").spaceId,
    getAccountSpaceId: () => ACCOUNT_SPACE,
    ensureAccountSpaceHosted,
    getSpaces: () => spaceService as unknown as ISpaceService,
    getAccountDb: () => db as unknown as IDatabaseHandle,
  });
  return { service, stored, batchGet, put, get, batchPut, dbBatch, statements, ensureAccountSpaceHosted };
}

describe("AccountService.spaces.registerMissing", () => {
  test("preserves populated records and creates only missing canonical spaces", async () => {
    const fixtures = new Map<string, Record<string, unknown>>([
      [keyFor("default"), record("default", { name: "My renamed default" })],
      [keyFor("applications"), record("applications", { name: "My applications" })],
      [keyFor("account"), record("account", { name: "My account" })],
      [keyFor("secrets"), record("secrets", { name: "My archived secrets", status: "archived" })],
      [keyFor("agents"), record("agents", {
        name: "My agent archive",
        status: "archived",
        registered_at: "2026-01-02T03:04:05.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
        permissions: ["kv/get"],
      })],
    ]);
    const original = new Map([...fixtures].map(([key, value]) => [key, structuredClone(value)]));
    const harness = makeHarness({ initial: fixtures });

    const result = await harness.service.spaces.registerMissing(names.map(input));

    expect(result.ok).toBe(true);
    for (const [key, value] of original) expect(harness.stored.get(key)).toEqual(value);
    expect(harness.stored.get(keyFor("public"))).toMatchObject({
      name: "public",
      status: "active",
      permissions: ["*"],
    });
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledWith(keyFor("public"), expect.any(Object), { ifNoneMatch: "*" });
    expect(harness.batchGet).toHaveBeenCalledTimes(1);
    expect(harness.batchPut).not.toHaveBeenCalled();
    expect(harness.dbBatch).toHaveBeenCalledTimes(1);
    expect(harness.statements).toHaveLength(1);
    expect(harness.statements[0]!.params).toContain("My agent archive");
    expect(harness.statements[0]!.params).toContain("archived");
    expect(harness.statements[0]!.params).toContain("2026-01-02T03:04:05.000Z");
  });

  test("keeps a concurrent writer's record after conditional create loses the race", async () => {
    const racer = record("public", { name: "Racer-owned value", status: "archived" });
    const stored = new Map<string, Record<string, unknown>>();
    const harness = makeHarness({
      initial: stored,
      putImpl: async (key) => {
        stored.set(key, racer);
        return err(serviceError(ErrorCodes.KV_PRECONDITION_FAILED, "already exists", "kv"));
      },
    });

    const result = await harness.service.spaces.registerMissing([input("public")]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toContainEqual(expect.objectContaining({
      name: "Racer-owned value",
      status: "archived",
    }));
    expect(stored.get(keyFor("public"))).toEqual(racer);
    expect(harness.get).toHaveBeenCalledTimes(1);
    expect(harness.dbBatch).toHaveBeenCalledTimes(1);
  });

  test("returns the conditional put error when the key remains absent", async () => {
    const harness = makeHarness({
      putImpl: async () => err(serviceError(ErrorCodes.KV_WRITE_FAILED, "create failed", "kv")),
    });

    const result = await harness.service.spaces.registerMissing([input("public")]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_WRITE_FAILED, message: "create failed" } });
    expect(harness.get).toHaveBeenCalledTimes(1);
    expect(harness.dbBatch).not.toHaveBeenCalled();
  });

  test("does not write when a later key has unknown batch-read state", async () => {
    const harness = makeHarness({
      batchReadResult: (keys) => ok({
        results: [
          { key: keys[0]!, result: err(serviceError(ErrorCodes.KV_NOT_FOUND, "Key not found", "kv")) },
          { key: keys[1]!, result: err(serviceError(ErrorCodes.NETWORK_ERROR, "read failed", "kv")) },
        ],
        count: 2,
      }),
    });

    const result = await harness.service.spaces.registerMissing([input("public"), input("agents")]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR } });
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.dbBatch).not.toHaveBeenCalled();
  });

  test("does not write when the outer batch read fails", async () => {
    const harness = makeHarness({
      batchReadResult: () => err(serviceError(ErrorCodes.NETWORK_ERROR, "batch read failed", "kv")),
    });

    const result = await harness.service.spaces.registerMissing([input("public")]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR, message: "batch read failed" } });
    expect(harness.put).not.toHaveBeenCalled();
  });
});
