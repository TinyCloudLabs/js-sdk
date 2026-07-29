/**
 * Unit tests for TC-373 (P2): batch the account-bootstrap seed-spaces writes.
 *
 * `AccountService.spaces.registerBatch()` replaces 5 sequential
 * `register()` calls (5 KV puts + 5 index writes) with ONE KV batch write +
 * ONE multi-row index write. These tests pin the six corrected-design points
 * from the Sol plan review (2026-07-29):
 *
 *   1. invokeAny is threaded so batchPut is reachable at all (covered
 *      separately in TinyCloudNode.spaceScopedKV.test.ts, since that wiring
 *      lives in TinyCloudNode, not AccountService).
 *   2. the stored records are precomputed ONCE and reused byte-for-byte in
 *      any reconciliation fallback (no fresh timestamps).
 *   3. the index write is ONE multi-row statement, not N statements in one
 *      `db.batch` call.
 *   4. an index-write failure is best-effort and must never trigger a KV
 *      rewrite.
 *   5. the fallback is narrow: no retry on 401/403/402/413/404/abort, and an
 *      ambiguous failure's own error must survive even after a successful
 *      reconciliation.
 *   6. (validated in KVService.test.ts, since that's where the check lives)
 */
import { describe, expect, mock, test } from "bun:test";
import { ErrorCodes } from "@tinycloud/sdk-services";
import { AccountService } from "./AccountService";

const ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0xabc:account";

function makeSpace(name: string) {
  return {
    spaceId: `tinycloud:pkh:eip155:1:0xabc:${name}`,
    name,
    ownerDid: "did:pkh:eip155:1:0xabc",
    type: "owned" as const,
    permissions: ["*"],
    status: "active" as const,
  };
}

const FIVE_SPACES = ["default", "applications", "account", "secrets", "public"].map(makeSpace);

interface HarnessOptions {
  batchPutImpl?: (items: Array<{ key: string; value: unknown }>) => Promise<any>;
  putImpl?: (key: string, value: unknown) => Promise<any>;
  dbBatchImpl?: (statements: Array<{ sql: string; params?: unknown[] }>) => Promise<any>;
}

function makeHarness(options: HarnessOptions = {}) {
  const batchPutCalls: Array<Array<{ key: string; value: unknown }>> = [];
  const putCalls: Array<{ key: string; value: unknown }> = [];
  const dbBatchCalls: Array<Array<{ sql: string; params?: unknown[] }>> = [];

  const batchPut = mock(async (items: Array<{ key: string; value: unknown }>) => {
    batchPutCalls.push(items);
    if (options.batchPutImpl) return options.batchPutImpl(items);
    return { ok: true, data: { written: items.map((i) => i.key), count: items.length } };
  });

  const put = mock(async (key: string, value: unknown) => {
    putCalls.push({ key, value });
    if (options.putImpl) return options.putImpl(key, value);
    return { ok: true, data: { data: undefined, headers: {} } };
  });

  const dbBatch = mock(async (statements: Array<{ sql: string; params?: unknown[] }>) => {
    dbBatchCalls.push(statements);
    if (options.dbBatchImpl) return options.dbBatchImpl(statements);
    return { ok: true, data: { results: statements.map(() => ({ changes: 1, lastInsertRowId: 0 })) } };
  });

  const db = {
    migrations: {
      apply: mock(async (migrationOptions: any) => ({
        ok: true,
        data: {
          database: "account",
          namespace: migrationOptions.namespace,
          status: "already_current",
          applied: [],
          skipped: migrationOptions.migrations.map((m: any) => m.id),
        },
      })),
    },
    batch: dbBatch,
    query: mock(async () => ({ ok: true, data: { columns: [], rows: [], rowCount: 0 } })),
  };

  const ensureAccountSpaceHosted = mock(async () => {});

  const service = new AccountService({
    getDid: () => "did:pkh:eip155:1:0xabc",
    getHost: () => "https://node.tinycloud.xyz",
    getPrimarySpaceId: () => "tinycloud:pkh:eip155:1:0xabc:default",
    getAccountSpaceId: () => ACCOUNT_SPACE,
    ensureAccountSpaceHosted,
    getSpaces: () =>
      ({
        list: async () => ({ ok: true, data: [] }),
        get: () => ({
          kv: {
            batchPut,
            put,
            list: async () => ({ ok: true, data: { keys: [] } }),
            get: async () => ({
              ok: false,
              error: { code: "KV_NOT_FOUND", message: "n/a", service: "kv" },
            }),
            delete: async () => ({ ok: true, data: undefined }),
          },
          delegations: {
            list: async () => ({ ok: true, data: [] }),
            listReceived: async () => ({ ok: true, data: [] }),
            revoke: async () => ({ ok: true, data: undefined }),
          },
        }),
      }) as any,
    getAccountDb: () => db as any,
  });

  return { service, batchPut, batchPutCalls, put, putCalls, dbBatch, dbBatchCalls, ensureAccountSpaceHosted };
}

describe("AccountService.spaces.registerBatch", () => {
  test("writes all 5 spaces in ONE batchPut call, never falling back to per-space put", async () => {
    const { service, batchPut, put } = makeHarness();

    const result = await service.spaces.registerBatch(FIVE_SPACES);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toHaveLength(5);
    expect(batchPut).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    const [items] = batchPut.mock.calls[0] as [Array<{ key: string }>];
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.key).sort()).toEqual(
      FIVE_SPACES.map((s) => `spaces/${s.spaceId}`).sort(),
    );
  });

  test("returns [] without touching KV or the index for an empty input", async () => {
    const { service, batchPut, put, dbBatch } = makeHarness();

    const result = await service.spaces.registerBatch([]);

    expect(result).toEqual({ ok: true, data: [] });
    expect(batchPut).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(dbBatch).not.toHaveBeenCalled();
  });

  test("upserts the index in ONE multi-row INSERT OR REPLACE statement, not 5 statements", async () => {
    const { service, dbBatch, dbBatchCalls } = makeHarness();

    await service.spaces.registerBatch(FIVE_SPACES);

    expect(dbBatch).toHaveBeenCalledTimes(1);
    const statements = dbBatchCalls[0]!;
    // ONE statement in the batch array (SQLite statement atomicity), not 5.
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toStartWith("INSERT OR REPLACE INTO spaces");
    // 5 value-groups of 9 columns each.
    const valueGroups = statements[0]!.sql.match(/\(\?, \?, \?, \?, \?, \?, \?, \?, \?\)/g) ?? [];
    expect(valueGroups).toHaveLength(5);
    expect(statements[0]!.params).toHaveLength(45);
  });

  test.each([
    ["auth (401/403)", { code: ErrorCodes.AUTH_UNAUTHORIZED, message: "Unauthorized Action: spaces// / tinycloud.kv/put", service: "kv" }],
    ["quota (402)", { code: ErrorCodes.STORAGE_QUOTA_EXCEEDED, message: "Storage quota exceeded", service: "kv" }],
    ["quota (413)", { code: ErrorCodes.STORAGE_LIMIT_REACHED, message: "Storage limit reached", service: "kv" }],
    ["space not hosted (404)", { code: "KV_WRITE_FAILED", message: "404 - Space not found", service: "kv", meta: { status: 404 } }],
    ["caller abort", { code: ErrorCodes.ABORTED, message: "Request was aborted.", service: "kv" }],
  ])("never falls back to per-space put for %s", async (_label, error) => {
    const { service, put, batchPut } = makeHarness({
      batchPutImpl: async () => ({ ok: false, error }),
    });

    const result = await service.spaces.registerBatch(FIVE_SPACES);

    expect(result.ok).toBe(false);
    expect(batchPut).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error.code).toBe(error.code);
    }
  });

  test("reconciles an ambiguous failure via per-space puts using IDENTICAL bytes, and preserves the original error", async () => {
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnCalls.push(args);
    }) as typeof console.warn;

    try {
      const { service, put, putCalls, batchPutCalls } = makeHarness({
        batchPutImpl: async () => ({
          ok: false,
          error: {
            code: "KV_WRITE_FAILED",
            message: "500 - internal error after commit",
            service: "kv",
            meta: { status: 500 },
          },
        }),
      });

      const result = await service.spaces.registerBatch(FIVE_SPACES);

      expect(result.ok).toBe(true);
      expect(put).toHaveBeenCalledTimes(5);

      // The fallback must reuse the EXACT SAME record objects computed for
      // the batch attempt, not regenerate them via a second
      // spaceRecordFromInput call. Assert reference identity (`toBe`), not
      // deep equality: two independently-computed timestamps could
      // coincidentally land in the same millisecond in a fast test, which
      // would make a deep-equality check pass even for a regenerated
      // object. Reference identity can only hold if the value was truly
      // reused, so it is immune to that coincidence.
      //
      // Read from our own harness arrays (batchPutCalls / putCalls), not
      // bun's `mock.calls` snapshot — bun's own call recording does not
      // preserve object identity across calls and would silently defeat
      // this exact check regardless of what the production code does.
      const batchItems = batchPutCalls[0]!;
      expect(batchItems).toHaveLength(5);
      for (const item of batchItems) {
        const fallback = putCalls.find((call) => call.key === item.key);
        expect(fallback?.value).toBe(item.value);
      }

      // The original batch error must not vanish just because the fallback
      // succeeded — a silent swallow here is exactly how ambiguous failures
      // turn into undiagnosable half-provisioned accounts.
      expect(warnCalls).toHaveLength(1);
      expect(String(warnCalls[0]![0])).toContain("500 - internal error after commit");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("surfaces BOTH errors when the ambiguous-failure reconciliation itself fails", async () => {
    const { service } = makeHarness({
      batchPutImpl: async () => ({
        ok: false,
        error: { code: "KV_WRITE_FAILED", message: "502 bad gateway", service: "kv", meta: { status: 502 } },
      }),
      putImpl: async (key: string) => ({
        ok: false,
        error: { code: "KV_WRITE_FAILED", message: `write failed for ${key}`, service: "kv" },
      }),
    });

    const result = await service.spaces.registerBatch(FIVE_SPACES);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("502 bad gateway");
      expect(result.error.message).toContain("write failed for");
    }
  });

  test("an index-write failure does not trigger a KV rewrite, and the canonical write still succeeds", async () => {
    const { service, batchPut, put, dbBatch } = makeHarness({
      dbBatchImpl: async () => ({
        ok: false,
        error: { code: "SQL_PERMISSION_DENIED", message: "403 - not authorized", service: "sql" },
      }),
    });

    const result = await service.spaces.registerBatch(FIVE_SPACES);

    // Index failure is best-effort: it must not fail the canonical KV write.
    expect(result.ok).toBe(true);
    expect(batchPut).toHaveBeenCalledTimes(1);
    // Crucially: the index failure must not cause a retry/rewrite of the KV data.
    expect(put).not.toHaveBeenCalled();
    expect(dbBatch).toHaveBeenCalledTimes(1);
  });
});
