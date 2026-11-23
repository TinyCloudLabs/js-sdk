/**
 * TC-3688: a session that cannot write the account index (`tinycloud.sql`
 * write and schema on `account/account`) must not attempt the index writes.
 * The node refuses them with a 401 on every account space registered on a
 * fresh account's first load. Canonical KV reads and writes are unaffected.
 */
import { describe, expect, mock, test } from "bun:test";
import { AccountService } from "./AccountService";

const OWNER_DID = "did:pkh:eip155:1:0xabc";
const ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0xabc:account";

const SPACE = {
  spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
  name: "default",
  ownerDid: OWNER_DID,
  type: "owned" as const,
  permissions: ["*"],
  status: "active" as const,
};

function makeHarness(canWriteAccountIndex?: () => boolean) {
  const put = mock(async (_key: string, _value: unknown) => ({ ok: true as const, data: { data: undefined, headers: {} } }));
  const batchPut = mock(async (items: Array<{ key: string; value: unknown }>) => ({
    ok: true as const,
    data: { written: items.map((item) => item.key), count: items.length },
  }));
  const dbBatch = mock(async (statements: Array<{ sql: string }>) => ({
    ok: true as const,
    data: { results: statements.map(() => ({ changes: 1, lastInsertRowId: 0 })) },
  }));
  const migrationsApply = mock(async (options: { namespace: string; migrations: Array<{ id: string }> }) => ({
    ok: true as const,
    data: { database: "account", namespace: options.namespace, status: "applied", applied: options.migrations.map((m) => m.id), skipped: [] },
  }));
  // A fresh account: the index table is not there, so index reads say so.
  const dbQuery = mock(async () => ({
    ok: false as const,
    error: { code: "SQL_ERROR", message: "no such table: spaces", service: "sql" },
  }));
  const db = { migrations: { apply: migrationsApply }, batch: dbBatch, query: dbQuery };
  const getAccountDb = mock(() => db);

  const service = new AccountService({
    getDid: () => OWNER_DID,
    getHost: () => "https://tinycloud.test",
    getPrimarySpaceId: () => SPACE.spaceId,
    getAccountSpaceId: () => ACCOUNT_SPACE,
    ensureAccountSpaceHosted: async () => {},
    ...(canWriteAccountIndex ? { canWriteAccountIndex } : {}),
    getSpaces: () =>
      ({
        list: async () => ({
          ok: true,
          data: [{ id: SPACE.spaceId, name: SPACE.name, owner: OWNER_DID, type: "owned", permissions: ["*"] }],
        }),
        get: () => ({
          kv: {
            put,
            batchPut,
            list: async () => ({ ok: true, data: { keys: [] } }),
            get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "n/a", service: "kv" } }),
            delete: async () => ({ ok: true, data: undefined }),
          },
          delegations: {
            list: async () => ({ ok: true, data: [] }),
            listReceived: async () => ({ ok: true, data: [] }),
            revoke: async () => ({ ok: true, data: undefined }),
          },
        }),
      }) as never,
    getAccountDb: getAccountDb as never,
  });

  return { service, put, batchPut, dbBatch, migrationsApply, getAccountDb };
}

describe("account index writes follow the session's index access (TC-3688)", () => {
  test("a session without index write access registers spaces in KV and sends nothing to the index database", async () => {
    const { service, put, batchPut, dbBatch, migrationsApply } = makeHarness(() => false);

    const single = await service.spaces.register(SPACE);
    const batch = await service.spaces.registerBatch([SPACE]);

    expect(single.ok).toBe(true);
    expect(batch.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(batchPut).toHaveBeenCalledTimes(1);
    expect(migrationsApply).not.toHaveBeenCalled();
    expect(dbBatch).not.toHaveBeenCalled();
  });

  test("an index-less first load lists spaces from the canonical records without index writes", async () => {
    const { service, put, dbBatch, migrationsApply } = makeHarness(() => false);

    const listed = await service.spaces.list({ preferIndex: true, refreshIndex: false });

    expect(listed.ok && listed.data.map((space) => space.spaceId)).toEqual([SPACE.spaceId]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(migrationsApply).not.toHaveBeenCalled();
    expect(dbBatch).not.toHaveBeenCalled();
  });

  test("removing a space does not touch the index database either", async () => {
    const { service, dbBatch, migrationsApply } = makeHarness(() => false);

    await service.spaces.remove(SPACE.spaceId);

    expect(migrationsApply).not.toHaveBeenCalled();
    expect(dbBatch).not.toHaveBeenCalled();
  });

  test("ensuring the index with no write access succeeds without sending anything to the index database", async () => {
    const { service, dbBatch, migrationsApply } = makeHarness(() => false);

    const ensured = await service.index.ensure();

    expect(ensured).toEqual({ ok: true, data: { database: "account" } });
    expect(migrationsApply).not.toHaveBeenCalled();
    expect(dbBatch).not.toHaveBeenCalled();
  });

  test("a session with index write access still writes the index", async () => {
    const { service, dbBatch, migrationsApply } = makeHarness(() => true);

    await service.spaces.register(SPACE);

    expect(migrationsApply).toHaveBeenCalledTimes(1);
    expect(dbBatch).toHaveBeenCalledTimes(1);
  });

  test("a config without the check keeps writing the index", async () => {
    const { service, dbBatch, migrationsApply } = makeHarness();

    await service.spaces.register(SPACE);

    expect(migrationsApply).toHaveBeenCalledTimes(1);
    expect(dbBatch).toHaveBeenCalledTimes(1);
  });
});
