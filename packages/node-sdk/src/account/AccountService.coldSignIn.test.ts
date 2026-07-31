/**
 * Cold sign-in request-count guards for AccountService (TC-293).
 *
 * Account bootstrap touches the materialized index eight times and registers
 * the bootstrap manifest once. These tests pin the two behaviours that keep
 * that from costing ~17 avoidable round trips:
 *
 *   - the index schema migration is applied at most once per account space
 *     (P1), and a failure is never cached;
 *   - the bootstrap manifest write skips the `application_state` pre-read
 *     that can only ever miss on a fresh account (P5), without weakening the
 *     dedupe on the normal re-registration path.
 */
import { describe, expect, mock, test } from "bun:test";

import type { Manifest } from "@tinycloud/sdk-core";

import { AccountService } from "./AccountService";

const ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0xabc:account";
const OTHER_ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0xdef:account";

const MANIFEST: Manifest = {
  app_id: "com.notes.app",
  name: "Notes",
  defaults: false,
};

function makeHarness(
  options: {
    /** Number of leading `migrations.apply` calls that should fail. */
    migrationFailures?: number;
    /** Make the `application_state` pre-read report the manifest as current. */
    indexReportsCurrent?: boolean;
  } = {},
) {
  let remainingFailures = options.migrationFailures ?? 0;
  let accountSpaceId = ACCOUNT_SPACE;

  const queries: string[] = [];
  const batches: Array<Array<{ sql: string; params?: unknown[] }>> = [];
  const puts: Array<{ key: string; value: any }> = [];

  const apply = mock(async (migrationOptions: any) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return {
        ok: false,
        error: {
          code: "SQL_PERMISSION_DENIED",
          message: "SQL migration failed: 403 - not authorized",
          service: "sql",
        },
      };
    }
    return {
      ok: true,
      data: {
        database: "account",
        namespace: migrationOptions.namespace,
        status: "already_current",
        applied: [],
        skipped: migrationOptions.migrations.map((m: any) => m.id),
      },
    };
  });

  const query = mock(async (sql: string, _params?: unknown[]) => {
    queries.push(sql);
    if (sql.includes("FROM application_state")) {
      return {
        ok: true,
        data: {
          columns: ["matched"],
          rows: options.indexReportsCurrent ? [["1"]] : [],
          rowCount: options.indexReportsCurrent ? 1 : 0,
        },
      };
    }
    return { ok: true, data: { columns: [], rows: [], rowCount: 0 } };
  });

  const batch = mock(async (statements: Array<{ sql: string; params?: unknown[] }>) => {
    batches.push(statements);
    return {
      ok: true,
      data: { results: statements.map(() => ({ changes: 1, lastInsertRowId: 0 })) },
    };
  });

  // A *fresh* handle per call, exactly like TinyCloudNode.getAccountDb, which
  // builds a new SQLService + ServiceContext every time. This is why
  // SQLService's own in-flight migration lock never helps here, and why the
  // memo must live on AccountService rather than on the handle.
  let handleCount = 0;
  const getAccountDb = () => {
    handleCount += 1;
    return { migrations: { apply }, query, batch } as any;
  };

  const put = mock(async (key: string, value: unknown) => {
    puts.push({ key, value });
    return { ok: true, data: { data: undefined, headers: {} } };
  });

  const service = new AccountService({
    getDid: () => "did:pkh:eip155:1:0xabc",
    getHost: () => "https://node.tinycloud.xyz",
    getPrimarySpaceId: () => "tinycloud:pkh:eip155:1:0xabc:default",
    getAccountSpaceId: () => accountSpaceId,
    ensureAccountSpaceHosted: mock(async () => {}),
    getSpaces: () =>
      ({
        list: async () => ({ ok: true, data: [] }),
        get: () => ({
          kv: {
            list: async () => ({ ok: true, data: { keys: [] } }),
            get: async () => ({
              ok: false,
              error: { code: "KV_NOT_FOUND", message: "Key not found", service: "kv" },
            }),
            put,
            delete: async () => ({ ok: true, data: undefined }),
          },
          delegations: {
            list: async () => ({ ok: true, data: [] }),
            listReceived: async () => ({ ok: true, data: [] }),
            revoke: async () => ({ ok: true, data: undefined }),
          },
        }),
      }) as any,
    getAccountDb,
  });

  return {
    apply,
    batches,
    put,
    puts,
    queries,
    service,
    handleCount: () => handleCount,
    useAccountSpace: (spaceId: string) => {
      accountSpaceId = spaceId;
    },
    applicationStateReads: () =>
      queries.filter((sql) => sql.includes("FROM application_state")),
  };
}

describe("AccountService account-index memo (P1)", () => {
  test("applies the index migration ONCE across the eight bootstrap index touches", async () => {
    const { apply, handleCount, service } = makeHarness();

    for (let i = 0; i < 8; i += 1) {
      const result = await service.index.ensure();
      expect(result.ok).toBe(true);
    }

    // Every touch still asked for a fresh db handle...
    expect(handleCount()).toBe(8);
    // ...but only the first paid the two-request migration probe.
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("shares the memo across different index entry points", async () => {
    const { apply, service } = makeHarness();

    await service.index.ensure();
    // Goes through upsertApplicationIndexQuietly -> ensureAccountIndex.
    await service.applications.register(MANIFEST);
    await service.applications.remove("com.notes.app");

    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("coalesces concurrent index touches into a single migration", async () => {
    const { apply, service } = makeHarness();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.index.ensure()),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("does NOT cache a failure: a later touch retries and can succeed", async () => {
    const { apply, service } = makeHarness({ migrationFailures: 1 });

    const first = await service.index.ensure();
    expect(first.ok).toBe(false);

    const second = await service.index.ensure();
    expect(second.ok).toBe(true);

    // The failure was evicted, so the retry really re-applied.
    expect(apply).toHaveBeenCalledTimes(2);

    // ...and the now-successful result IS memoized.
    await service.index.ensure();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test("does not cache a failure shared by concurrent callers", async () => {
    const { apply, service } = makeHarness({ migrationFailures: 1 });

    const [a, b] = await Promise.all([service.index.ensure(), service.index.ensure()]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);

    const retried = await service.index.ensure();
    expect(retried.ok).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test("keys the memo by account space, so a different account re-applies", async () => {
    const { apply, service, useAccountSpace } = makeHarness();

    await service.index.ensure();
    expect(apply).toHaveBeenCalledTimes(1);

    useAccountSpace(OTHER_ACCOUNT_SPACE);
    await service.index.ensure();
    expect(apply).toHaveBeenCalledTimes(2);

    // Back to the first account: still memoized.
    useAccountSpace(ACCOUNT_SPACE);
    await service.index.ensure();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test("index.rebuild re-applies the schema instead of trusting the memo", async () => {
    const { apply, service } = makeHarness();

    await service.index.ensure();
    expect(apply).toHaveBeenCalledTimes(1);

    const rebuilt = await service.index.rebuild();
    expect(rebuilt.ok).toBe(true);
    // rebuild is the explicit repair path: it must re-verify server-side.
    expect(apply).toHaveBeenCalledTimes(2);
  });
});

describe("AccountService bootstrap manifest write (P5)", () => {
  test("assumeUnregistered skips the application_state pre-read", async () => {
    // The index would claim the manifest is already current; the bootstrap
    // path must not even ask.
    const { applicationStateReads, put, service } = makeHarness({
      indexReportsCurrent: true,
    });

    const result = await service.applications.register(MANIFEST, {
      assumeUnregistered: true,
    });

    expect(result.ok).toBe(true);
    expect(applicationStateReads()).toEqual([]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("without the flag the pre-read still short-circuits a redundant write", async () => {
    const { applicationStateReads, put, service } = makeHarness({
      indexReportsCurrent: true,
    });

    const result = await service.applications.register(MANIFEST);

    expect(result.ok).toBe(true);
    // The warm dedupe is intact: one pre-read, zero writes.
    expect(applicationStateReads()).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  test("re-registering the same manifest with assumeUnregistered is idempotent", async () => {
    const { batches, put, puts, service } = makeHarness({ indexReportsCurrent: true });

    const first = await service.applications.register(MANIFEST, {
      assumeUnregistered: true,
    });
    const second = await service.applications.register(MANIFEST, {
      assumeUnregistered: true,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);

    // Same key, same content (modulo the updated_at stamp): repeating the
    // write cannot change what is stored.
    expect(puts[0]!.key).toBe(puts[1]!.key);
    expect(puts[0]!.value.app_id).toBe(puts[1]!.value.app_id);
    expect(puts[0]!.value.manifests).toEqual(puts[1]!.value.manifests);
    expect(puts[0]!.value.manifest_hash).toBe(puts[1]!.value.manifest_hash);

    // Both index updates are one batch of INSERT OR REPLACE statements, so
    // they are replayable too — and cost one request, not two.
    expect(batches).toHaveLength(2);
    for (const statements of batches) {
      expect(statements).toHaveLength(2);
      expect(statements.every((s) => s.sql.startsWith("INSERT OR REPLACE"))).toBe(true);
    }
  });

  test("register still reports the existing record when the pre-read hits", async () => {
    const { service } = makeHarness({ indexReportsCurrent: true });

    const result = await service.applications.register(MANIFEST);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.appId).toBe("com.notes.app");
    expect(result.ok && result.data.manifests).toEqual([MANIFEST]);
  });
});
