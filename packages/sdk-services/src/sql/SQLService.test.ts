import { describe, expect, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
} from "../types";
import { SQLService } from "./SQLService";
import { SQLAction } from "./types";

function response(
  ok: boolean,
  status: number,
  body: unknown,
  statusText = ok ? "OK" : "Error",
): FetchResponse {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: () => null,
    },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () =>
      new TextEncoder().encode(
        typeof body === "string" ? body : JSON.stringify(body),
      ).buffer as ArrayBuffer,
    blob: async () =>
      new Blob([typeof body === "string" ? body : JSON.stringify(body)]),
  };
}

function createContext(
  fetchImpl: IServiceContext["fetch"],
  invokeCalls: Array<{ service: string; path: string; action: string }>,
  invokeAnyCalls: Array<{ entries: Array<{ service: string; path: string; action: string }> }> = [],
): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: (_session, service, path, action) => {
      invokeCalls.push({ service, path, action });
      return {
        Authorization: "Bearer signed-invocation",
      };
    },
    invokeAny: (_session, entries) => {
      invokeAnyCalls.push({
        entries: entries.map((entry) => ({
          service: entry.service,
          path: entry.path,
          action: entry.action,
        })),
      });
      return {
        Authorization: "Bearer signed-multi-invocation",
      };
    },
    fetch: fetchImpl,
    hosts: ["https://node.tinycloud.xyz"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: [],
    },
  };
}

describe("SQLService permissions", () => {
  test("query signs SELECT statements with read permission", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    let requestInit: FetchRequestInit | undefined;

    const service = new SQLService();
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, {
          columns: ["value"],
          rows: [[1]],
          rowCount: 1,
        });
      }, invokeCalls),
    );

    const result = await service.query("SELECT 1 AS value");

    expect(result.ok).toBe(true);
    expect(invokeCalls).toEqual([
      { service: "sql", path: "default", action: SQLAction.READ },
    ]);
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      action: "query",
      sql: "SELECT 1 AS value",
      params: [],
    });
  });

  test("query recognizes PRAGMA after leading comments", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];

    const service = new SQLService();
    service.initialize(
      createContext(async () => response(true, 200, {
        columns: ["name"],
        rows: [],
        rowCount: 0,
      }), invokeCalls),
    );

    const result = await service.query(`
      -- schema introspection
      /* migration probe */
      pragma table_info(secret_records)
    `);

    expect(result.ok).toBe(true);
    expect(invokeCalls).toEqual([
      { service: "sql", path: "default", action: SQLAction.ADMIN },
    ]);
  });

  test("execute and batch sign PRAGMA statements with admin permission", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    const invokeAnyCalls: Array<{ entries: Array<{ service: string; path: string; action: string }> }> = [];

    const service = new SQLService();
    service.initialize(
      createContext(async () => response(true, 200, {
        changes: 0,
        lastInsertRowId: null,
      }), invokeCalls, invokeAnyCalls),
    );

    const executeResult = await service.execute("pragma user_version = 1");
    const batchResult = await service.batch([
      { sql: "INSERT INTO notes (body) VALUES (?)", params: ["hello"] },
      { sql: "PRAGMA user_version" },
    ]);

    expect(executeResult.ok).toBe(true);
    expect(batchResult.ok).toBe(true);
    expect(invokeCalls).toEqual([
      { service: "sql", path: "default", action: SQLAction.ADMIN },
    ]);
    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          { service: "sql", path: "default", action: SQLAction.WRITE },
          { service: "sql", path: "default", action: SQLAction.ADMIN },
        ],
      },
    ]);
  });

  test("execute and batch sign DDL statements with ddl permission", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    const invokeAnyCalls: Array<{ entries: Array<{ service: string; path: string; action: string }> }> = [];

    const service = new SQLService();
    service.initialize(
      createContext(async () => response(true, 200, {
        changes: 0,
        lastInsertRowId: null,
      }), invokeCalls, invokeAnyCalls),
    );

    const executeResult = await service.execute("CREATE TABLE IF NOT EXISTS notes (body TEXT)");
    const batchResult = await service.batch([
      { sql: "CREATE TABLE IF NOT EXISTS notes (body TEXT)" },
      { sql: "INSERT INTO notes (body) VALUES (?)", params: ["hello"] },
    ]);

    expect(executeResult.ok).toBe(true);
    expect(batchResult.ok).toBe(true);
    expect(invokeCalls).toEqual([
      { service: "sql", path: "default", action: SQLAction.DDL },
    ]);
    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          { service: "sql", path: "default", action: SQLAction.DDL },
          { service: "sql", path: "default", action: SQLAction.WRITE },
        ],
      },
    ]);
  });

  test("execute with schema signs both schema ddl and statement write permissions", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    const invokeAnyCalls: Array<{ entries: Array<{ service: string; path: string; action: string }> }> = [];

    const service = new SQLService();
    service.initialize(
      createContext(async () => response(true, 200, {
        changes: 1,
        lastInsertRowId: 1,
      }), invokeCalls, invokeAnyCalls),
    );

    const result = await service.execute(
      "INSERT INTO notes (body) VALUES (?)",
      ["hello"],
      { schema: ["CREATE TABLE IF NOT EXISTS notes (body TEXT)"] },
    );

    expect(result.ok).toBe(true);
    expect(invokeCalls).toEqual([]);
    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          { service: "sql", path: "default", action: SQLAction.WRITE },
          { service: "sql", path: "default", action: SQLAction.DDL },
        ],
      },
    ]);
  });
});
