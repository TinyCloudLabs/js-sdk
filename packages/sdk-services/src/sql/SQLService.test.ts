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

  test("execute and batch sign schema statements with schema permission", async () => {
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
      { service: "sql", path: "default", action: SQLAction.SCHEMA },
    ]);
    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          { service: "sql", path: "default", action: SQLAction.SCHEMA },
          { service: "sql", path: "default", action: SQLAction.WRITE },
        ],
      },
    ]);
  });

  test("execute with schema signs both schema and statement write permissions", async () => {
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
          { service: "sql", path: "default", action: SQLAction.SCHEMA },
        ],
      },
    ]);
  });

  test("migrations.apply creates metadata table, applies pending SQL, and records ids", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    const invokeAnyCalls: Array<{ entries: Array<{ service: string; path: string; action: string }> }> = [];
    const bodies: any[] = [];

    const service = new SQLService();
    service.initialize(
      createContext(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        bodies.push(body);

        if (body.action === "query") {
          return response(true, 200, {
            columns: ["id"],
            rows: [],
            rowCount: 0,
          });
        }

        if (body.action === "batch") {
          return response(true, 200, {
            results: body.statements.map(() => ({ changes: 1, lastInsertRowId: null })),
          });
        }

        return response(true, 200, {
          changes: 0,
          lastInsertRowId: null,
        });
      }, invokeCalls, invokeAnyCalls),
    );

    const result = await service.db("app.db").migrations.apply({
      namespace: "com.example.app",
      migrations: [
        {
          id: "001_initial",
          sql: [
            "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)",
            { sql: "CREATE INDEX IF NOT EXISTS idx_notes_body ON notes(body)" },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        database: "app.db",
        namespace: "com.example.app",
        status: "applied",
        applied: ["001_initial"],
        skipped: [],
      });
    }
    expect(invokeCalls).toEqual([
      { service: "sql", path: "app.db", action: SQLAction.READ },
    ]);
    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          { service: "sql", path: "app.db", action: SQLAction.SCHEMA },
          { service: "sql", path: "app.db", action: SQLAction.WRITE },
        ],
      },
      {
        entries: [
          { service: "sql", path: "app.db", action: SQLAction.SCHEMA },
          { service: "sql", path: "app.db", action: SQLAction.WRITE },
        ],
      },
    ]);
    expect(bodies[0].action).toBe("batch");
    expect(bodies[0].statements[0].sql).toContain("__tinycloud_sql_migrations");
    expect(bodies[0].statements[1].params[1]).toBe("tinycloud.sql.migrations");
    expect(bodies[1]).toEqual({
      action: "query",
      sql: "SELECT id FROM __tinycloud_sql_migrations WHERE namespace = ? ORDER BY applied_at, id",
      params: ["com.example.app"],
    });
    expect(bodies[2]).toEqual({
      action: "batch",
      statements: [
        { sql: "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)" },
        { sql: "CREATE INDEX IF NOT EXISTS idx_notes_body ON notes(body)" },
        {
          sql: "INSERT OR REPLACE INTO __tinycloud_sql_migrations (key, namespace, id, applied_at, statement_count) VALUES (?, ?, ?, ?, ?)",
          params: [
            "com.example.app:001_initial",
            "com.example.app",
            "001_initial",
            bodies[2].statements[2].params[3],
            2,
          ],
        },
      ],
    });
  });

  test("migrations.apply skips already recorded migrations", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    const invokeAnyCalls: Array<{ entries: Array<{ service: string; path: string; action: string }> }> = [];
    const bodies: any[] = [];

    const service = new SQLService();
    service.initialize(
      createContext(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        bodies.push(body);

        if (body.action === "query") {
          return response(true, 200, {
            columns: ["id"],
            rows: [["001_initial"]],
            rowCount: 1,
          });
        }

        if (body.action === "batch") {
          return response(true, 200, {
            results: body.statements.map(() => ({ changes: 1, lastInsertRowId: null })),
          });
        }

        return response(true, 200, {
          changes: 0,
          lastInsertRowId: null,
        });
      }, invokeCalls, invokeAnyCalls),
    );

    const result = await service.db("app.db").migrations.apply({
      namespace: "com.example.app",
      migrations: [
        {
          id: "001_initial",
          sql: ["CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        database: "app.db",
        namespace: "com.example.app",
        status: "already_current",
        applied: [],
        skipped: ["001_initial"],
      });
    }
    expect(invokeCalls).toEqual([
      { service: "sql", path: "app.db", action: SQLAction.READ },
    ]);
    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          { service: "sql", path: "app.db", action: SQLAction.SCHEMA },
          { service: "sql", path: "app.db", action: SQLAction.WRITE },
        ],
      },
    ]);
    expect(bodies.map((body) => body.action)).toEqual(["batch", "query"]);
  });

  test("SQL errors sanitize proxy HTML pages", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];

    const service = new SQLService();
    service.initialize(
      createContext(async () => response(false, 524,
        "<!DOCTYPE html><html><head><title>tinycloud.xyz | 524: A timeout occurred</title></head><body>Error code 524</body></html>",
        "Timeout",
      ), invokeCalls),
    );

    const result = await service.execute("CREATE TABLE IF NOT EXISTS notes (body TEXT)");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("SQL execute failed: upstream request timed out. Please retry.");
      expect(result.error.message).not.toContain("<!DOCTYPE html>");
      expect(result.error.meta?.responseSnippet).toContain("<!DOCTYPE html>");
    }
  });
});
