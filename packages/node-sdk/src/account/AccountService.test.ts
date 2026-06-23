import { describe, expect, mock, test } from "bun:test";
import { AccountService } from "./AccountService";
import type { Delegation, Manifest, SpaceInfo } from "@tinycloud/sdk-core";

function makeAccountService(options: {
  emptyIndexTables?: string[];
  failingIndexUpdates?: boolean;
  missingIndexTables?: string[];
} = {}) {
  const records = new Map<string, unknown>([
    [
      "applications/com.listen.app",
      {
        app_id: "com.listen.app",
        manifests: [{ app_id: "com.listen.app", name: "Listen" }],
        updated_at: "2026-06-20T00:00:00.000Z",
      },
    ],
  ]);
  const put = mock(async (key: string, value: unknown) => {
    records.set(key, value);
    return { ok: true, data: { data: undefined, headers: {} } };
  });
  const del = mock(async (key: string) => {
    records.delete(key);
    return { ok: true, data: undefined };
  });
  const revoke = mock(async () => ({ ok: true, data: undefined }));
  const ensureAccountSpaceHosted = mock(async () => {});
  const batches: any[] = [];
  const migrations: any[] = [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    migrations: {
      apply: mock(async (migrationOptions: any) => {
        migrations.push(migrationOptions);
        if (options.failingIndexUpdates) {
          return {
            ok: false,
            error: {
              code: "SQL_PERMISSION_DENIED",
              message: "SQL migration failed: 403 - not authorized",
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
            skipped: migrationOptions.migrations.map((migration: any) => migration.id),
          },
        };
      }),
    },
    batch: mock(async (statements: any[]) => {
      batches.push(statements);
      if (options.failingIndexUpdates) {
        return {
          ok: false,
          error: {
            code: "SQL_PERMISSION_DENIED",
            message: "SQL batch failed: 403 - not authorized",
          },
        };
      }
      return { ok: true, data: { results: statements.map(() => ({ changes: 1, lastInsertRowId: 0 })) } };
    }),
    query: mock(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const missing = options.missingIndexTables?.find((table) => sql.includes(`FROM ${table}`));
      if (missing) {
        return {
          ok: false,
          error: {
            code: "SQL_ERROR",
            message: `SQL query failed: 400 - SQLite error: no such table: ${missing}`,
          },
        };
      }
      if (sql.includes("FROM application_state")) {
        return {
          ok: true,
          data: {
            columns: ["matched"],
            rows: [],
            rowCount: 0,
          },
        };
      }
      if (sql.includes("FROM applications")) {
        if (options.emptyIndexTables?.includes("applications")) {
          return {
            ok: true,
            data: {
              columns: ["app_id", "name", "description", "updated_at", "manifest_json", "manifest_hash"],
              rows: [],
              rowCount: 0,
            },
          };
        }
        return {
          ok: true,
          data: {
            columns: ["app_id", "name", "description", "updated_at", "manifest_json", "manifest_hash"],
            rows: [
              [
                "com.listen.app",
                "Listen",
                "Conversation memory",
                "2026-06-20T00:00:00.000Z",
                JSON.stringify([{ app_id: "com.listen.app", name: "Listen" }]),
                "080c363ec8fc3d69",
              ],
            ],
            rowCount: 1,
          },
        };
      }
      if (sql.includes("FROM spaces")) {
        if (options.emptyIndexTables?.includes("spaces")) {
          return {
            ok: true,
            data: {
              columns: [
                "space_id",
                "name",
                "owner_did",
                "type",
                "permissions_json",
                "status",
                "registered_at",
                "updated_at",
                "expires_at",
              ],
              rows: [],
              rowCount: 0,
            },
          };
        }
        return {
          ok: true,
          data: {
            columns: [
              "space_id",
              "name",
              "owner_did",
              "type",
              "permissions_json",
              "status",
              "registered_at",
              "updated_at",
              "expires_at",
            ],
            rows: [
              [
                spaces[0]!.id,
                "applications",
                "did:pkh:eip155:1:0xabc",
                "owned",
                JSON.stringify(["*"]),
                "active",
                "2026-06-20T00:00:00.000Z",
                "2026-06-20T00:00:00.000Z",
                null,
              ],
            ],
            rowCount: 1,
          },
        };
      }
      if (sql.includes("FROM delegations")) {
        if (options.emptyIndexTables?.includes("delegations")) {
          return {
            ok: true,
            data: {
              columns: [
                "cid",
                "direction",
                "space_id",
                "space_name",
                "counterparty_did",
                "delegate_did",
                "delegator_did",
                "path",
                "actions_json",
                "expiry",
                "status",
                "created_at",
              ],
              rows: [],
              rowCount: 0,
            },
          };
        }
        return {
          ok: true,
          data: {
            columns: [
              "cid",
              "direction",
              "space_id",
              "space_name",
              "counterparty_did",
              "delegate_did",
              "delegator_did",
              "path",
              "actions_json",
              "expiry",
              "status",
              "created_at",
            ],
            rows: [
              [
                "bafy-granted",
                "granted",
                spaces[0]!.id,
                "applications",
                "did:key:zdelegate",
                "did:key:zdelegate",
                "did:pkh:eip155:1:0xabc",
                "applications/com.listen.app/",
                JSON.stringify(["tinycloud.kv/get"]),
                "2026-07-20T00:00:00.000Z",
                "active",
                null,
              ],
            ],
            rowCount: 1,
          },
        };
      }
      return {
        ok: true,
        data: { columns: ["value"], rows: [[1]], rowCount: 1 },
      };
    }),
  };

  const spaces: SpaceInfo[] = [
    {
      id: "tinycloud:pkh:eip155:1:0xabc:applications",
      name: "applications",
      owner: "did:pkh:eip155:1:0xabc",
      isOwned: true,
      isDelegated: false,
    } as SpaceInfo,
  ];

  const granted: Delegation = {
    cid: "bafy-granted",
    delegateDID: "did:key:zdelegate",
    delegatorDID: "did:pkh:eip155:1:0xabc",
    spaceId: spaces[0]!.id,
    path: "applications/com.listen.app/",
    actions: ["tinycloud.kv/get"],
    expiry: new Date(Date.now() + 60_000),
    isRevoked: false,
  };
  const received: Delegation = {
    cid: "bafy-received",
    delegateDID: "did:pkh:eip155:1:0xabc",
    delegatorDID: "did:key:zgrantor",
    spaceId: spaces[0]!.id,
    path: "shared/",
    actions: ["tinycloud.kv/list"],
    expiry: new Date(Date.now() + 60_000),
    isRevoked: false,
  };

  const service = new AccountService({
    getDid: () => "did:pkh:eip155:1:0xabc",
    getHost: () => "https://node.tinycloud.xyz",
    getPrimarySpaceId: () => "tinycloud:pkh:eip155:1:0xabc:default",
    getAccountSpaceId: () => "tinycloud:pkh:eip155:1:0xabc:account",
    ensureAccountSpaceHosted,
    getSpaces: () =>
      ({
        list: async () => ({ ok: true, data: spaces }),
        get: (_spaceId: string) => ({
          kv: {
            list: async () => ({ ok: true, data: { keys: [...records.keys()] } }),
            get: async (key: string) => ({ ok: true, data: { data: records.get(key), headers: {} } }),
            put,
            delete: del,
          },
          delegations: {
            list: async () => ({ ok: true, data: [granted] }),
            listReceived: async () => ({ ok: true, data: [received] }),
            revoke,
          },
        }),
      }) as any,
    getAccountDb: () => db as any,
  });

  return { batches, db, del, ensureAccountSpaceHosted, migrations, put, queries, records, revoke, service };
}

describe("AccountService applications", () => {
  test("lists account application registry records", async () => {
    const { service } = makeAccountService();

    const result = await service.applications.list();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual([
      {
        appId: "com.listen.app",
        manifests: [{ app_id: "com.listen.app", name: "Listen" }],
        manifestHash: "080c363ec8fc3d69",
        name: "Listen",
        description: undefined,
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
  });

  test("registers manifest records using the shared manifest composer", async () => {
    const { ensureAccountSpaceHosted, put, service } = makeAccountService();
    const manifest: Manifest = {
      app_id: "com.notes.app",
      name: "Notes",
      defaults: false,
    };

    const result = await service.applications.register(manifest);

    expect(result.ok).toBe(true);
    expect(ensureAccountSpaceHosted).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("applications/com.notes.app", {
      app_id: "com.notes.app",
      manifests: [manifest],
      manifest_hash: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  test("does not fail canonical manifest registration when index update fails", async () => {
    const { put, service } = makeAccountService({ failingIndexUpdates: true });
    const manifest: Manifest = {
      app_id: "com.notes.app",
      name: "Notes",
      defaults: false,
    };

    const result = await service.applications.register(manifest);

    expect(result.ok).toBe(true);
    expect(put).toHaveBeenCalledWith("applications/com.notes.app", expect.any(Object));
  });

  test("removes application registry records", async () => {
    const { del, service } = makeAccountService();

    const result = await service.applications.remove("com.listen.app");

    expect(result.ok).toBe(true);
    expect(del).toHaveBeenCalledWith("applications/com.listen.app");
  });
});

describe("AccountService delegations", () => {
  test("aggregates granted and received delegations", async () => {
    const { service } = makeAccountService();

    const result = await service.delegations.list();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.map((d) => [d.cid, d.direction, d.counterpartyDid])).toEqual([
      ["bafy-granted", "granted", "did:key:zdelegate"],
      ["bafy-received", "received", "did:key:zgrantor"],
    ]);
  });

  test("revokes a delegation in the selected space", async () => {
    const { revoke, service } = makeAccountService();

    const result = await service.delegations.revoke({
      cid: "bafy-granted",
      space: "applications",
    });

    expect(result.ok).toBe(true);
    expect(revoke).toHaveBeenCalledWith("bafy-granted");
  });
});

describe("AccountService index", () => {
  test("rebuilds the materialized account SQLite index", async () => {
    const { batches, migrations, service } = makeAccountService();

    const result = await service.index.rebuild();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      database: "account",
      applications: 1,
      delegations: 2,
    });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      namespace: "tinycloud.account.index",
      migrations: [
        {
          id: "001_initial",
        },
      ],
    });
    expect(migrations[0].migrations[0].sql.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS applications"))).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0].some((s: any) => s.sql.includes("INSERT INTO applications"))).toBe(true);
    expect(batches[0].some((s: any) => s.sql.includes("INSERT INTO delegations"))).toBe(true);
  });

  test("lists applications from the materialized index", async () => {
    const { service } = makeAccountService();

    const result = await service.index.applications.list();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual([
      {
        appId: "com.listen.app",
        name: "Listen",
        description: "Conversation memory",
        updatedAt: "2026-06-20T00:00:00.000Z",
        manifests: [{ app_id: "com.listen.app", name: "Listen" }],
        manifestHash: "080c363ec8fc3d69",
      },
    ]);
  });

  test("falls back to canonical applications when preferred index is missing", async () => {
    const { migrations, service } = makeAccountService({ missingIndexTables: ["applications"] });

    const result = await service.applications.list({ preferIndex: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual([
      expect.objectContaining({
        appId: "com.listen.app",
        name: "Listen",
      }),
    ]);
    expect(migrations[0].migrations[0].sql.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS applications"))).toBe(true);
  });

  test("falls back to canonical applications when preferred index is empty", async () => {
    const { service } = makeAccountService({ emptyIndexTables: ["applications"] });

    const result = await service.applications.list({ preferIndex: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data[0]).toMatchObject({
      appId: "com.listen.app",
      name: "Listen",
    });
  });

  test("lists spaces from the materialized index", async () => {
    const { service } = makeAccountService();

    const result = await service.index.spaces.list();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual([
      {
        spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
        name: "applications",
        ownerDid: "did:pkh:eip155:1:0xabc",
        type: "owned",
        permissions: ["*"],
        status: "active",
        registeredAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        expiresAt: undefined,
      },
    ]);
  });

  test("falls back to accessible spaces when preferred index is missing", async () => {
    const { migrations, service } = makeAccountService({ missingIndexTables: ["spaces"] });

    const result = await service.spaces.list({ preferIndex: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual([
      expect.objectContaining({
        spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
        name: "applications",
      }),
    ]);
    expect(migrations[0].migrations[0].sql.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS spaces"))).toBe(true);
  });

  test("lists delegations from the materialized index with filters", async () => {
    const { queries, service } = makeAccountService();

    const result = await service.index.delegations.list({
      direction: "granted",
      space: "applications",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data[0]).toMatchObject({
      cid: "bafy-granted",
      direction: "granted",
      spaceName: "applications",
      counterpartyDid: "did:key:zdelegate",
    });
    expect(queries.at(-1)).toMatchObject({
      params: ["granted", "applications", "applications"],
    });
  });

  test("falls back to live delegations when preferred index is missing", async () => {
    const { migrations, service } = makeAccountService({ missingIndexTables: ["delegations"] });

    const result = await service.delegations.list({ preferIndex: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.map((delegation) => delegation.cid)).toEqual([
      "bafy-granted",
      "bafy-received",
    ]);
    expect(migrations[0].migrations[0].sql.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS delegations"))).toBe(true);
  });

  test("runs custom read queries against the materialized index", async () => {
    const { service } = makeAccountService();

    const result = await service.index.query("SELECT 1 AS value");

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual({
      columns: ["value"],
      rows: [[1]],
      rowCount: 1,
    });
  });

  test("reports missing index status without surfacing raw SQLite table errors", async () => {
    const { service } = makeAccountService({ missingIndexTables: ["sync_state"] });

    const result = await service.index.status();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual({
      database: "account",
      state: "missing",
      sources: [],
    });
  });
});
