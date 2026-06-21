import { describe, expect, mock, test } from "bun:test";
import { AccountService } from "./AccountService";
import type { Delegation, Manifest, SpaceInfo } from "@tinycloud/sdk-core";

function makeAccountService() {
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
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    batch: mock(async (statements: any[]) => {
      batches.push(statements);
      return { ok: true, data: { results: statements.map(() => ({ changes: 1, lastInsertRowId: 0 })) } };
    }),
    query: mock(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM applications")) {
        return {
          ok: true,
          data: {
            columns: ["app_id", "name", "description", "updated_at", "manifest_json"],
            rows: [
              [
                "com.listen.app",
                "Listen",
                "Conversation memory",
                "2026-06-20T00:00:00.000Z",
                JSON.stringify([{ app_id: "com.listen.app", name: "Listen" }]),
              ],
            ],
            rowCount: 1,
          },
        };
      }
      if (sql.includes("FROM delegations")) {
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

  return { batches, db, del, ensureAccountSpaceHosted, put, queries, records, revoke, service };
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
      updated_at: expect.any(String),
    });
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
    const { batches, service } = makeAccountService();

    const result = await service.index.rebuild();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      database: "account",
      applications: 1,
      delegations: 2,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].some((s: any) => s.sql.includes("CREATE TABLE IF NOT EXISTS applications"))).toBe(true);
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
      },
    ]);
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
});
