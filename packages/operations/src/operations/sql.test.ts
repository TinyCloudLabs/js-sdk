import { describe, expect, test } from "bun:test";
import { SQLService } from "@tinycloud/node-sdk";

import type { RuntimeOperationContext } from "../contract.js";
import { sqlOperationDefinitions } from "./sql.js";

const OWNER_PRIMARY =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:primary";
const OWNER_APPLICATIONS =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";

function definition(id: string) {
  const found = sqlOperationDefinitions.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found as any;
}

function context(node: Record<string, unknown>): RuntimeOperationContext {
  return {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:delegate",
      space: OWNER_PRIMARY,
    },
    runtime: { node, granted: [] },
  };
}

describe("SQLite read operations", () => {
  test("plans exact database read authority and forwards node result bounds", async () => {
    const calls: unknown[][] = [];
    const node = sqlNode(async (...args: unknown[]) => {
      calls.push(args);
      return {
        ok: true,
        data: {
          columns: ["id", "payload"],
          rows: [[1, [0, 127, 255]]],
          rowCount: 1,
        },
      };
    });
    const operation = definition("tinycloud.sql.query");
    const input = operation.input.parse({
      space: "applications",
      database: "com.example.notes/data.sqlite",
      sql: "WITH selected AS (SELECT ? AS id, ? AS payload) SELECT * FROM selected",
      params: [1, { type: "blob", base64: "AH//" }],
      maxRows: 10,
      maxBytes: 4096,
    });

    expect(await operation.authority(context(node), input)).toEqual([{
      service: "tinycloud.sql",
      space: OWNER_APPLICATIONS,
      path: "com.example.notes/data.sqlite",
      actions: ["tinycloud.sql/read"],
    }]);
    expect(await operation.execute(context(node), input)).toEqual({
      status: "ok",
      output: {
        space: OWNER_APPLICATIONS,
        database: "com.example.notes/data.sqlite",
        columns: ["id", "payload"],
        rows: [[1, { type: "blob", base64: "AH//", byteLength: 3 }]],
        rowCount: 1,
        limits: {
          maxRows: 10,
          maxBytes: 4096,
          enforcement: "node-requested-client-verified",
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain("WITH selected");
    expect(calls[0]?.[1]).toEqual([1, new Uint8Array([0, 127, 255])]);
    expect(calls[0]?.[2]).toEqual({ maxRows: 10, maxBytes: 4096 });
  });

  test("schema inspection runs only the fixed bounded sqlite_schema query", async () => {
    const calls: unknown[][] = [];
    const node = sqlNode(async (...args: unknown[]) => {
      calls.push(args);
      return {
        ok: true,
        data: {
          columns: ["type", "name", "tbl_name", "sql"],
          rows: [
            ["table", "notes", "notes", "CREATE TABLE notes (id INTEGER)"],
            ["index", "notes_by_id", "notes", null],
          ],
          rowCount: 2,
        },
      };
    });
    const operation = definition("tinycloud.sql.schema.inspect");
    const input = operation.input.parse({ space: "applications", database: "notes" });

    expect(await operation.execute(context(node), input)).toMatchObject({
      status: "ok",
      output: {
        count: 2,
        objects: [
          { type: "table", name: "notes", tableName: "notes", sql: "CREATE TABLE notes (id INTEGER)" },
          { type: "index", name: "notes_by_id", tableName: "notes" },
        ],
      },
    });
    expect(calls[0]?.[0]).toContain("FROM sqlite_schema");
    expect(calls[0]?.[1]).toEqual([]);
    expect(calls[0]?.[2]).toEqual({ maxRows: 500, maxBytes: 1024 * 1024 });
  });

  test("fails closed on writes, administrative SQL, malformed SQL, and multiple statements", () => {
    const operation = definition("tinycloud.sql.query");
    for (const sql of [
      "UPDATE notes SET body = 'changed'",
      "DELETE FROM notes",
      "CREATE TABLE hidden (id INTEGER)",
      "PRAGMA table_info(notes)",
      "EXPLAIN SELECT * FROM notes",
      "SELECT 1; SELECT 2",
      "SELEC * FROM notes",
    ]) {
      expect(operation.input.safeParse({
        space: "applications",
        database: "notes",
        sql,
      }).success).toBe(false);
    }
    expect(operation.input.safeParse({
      space: "applications",
      database: "notes",
      sql: "WITH notes_cte AS (SELECT 1 AS id) SELECT id FROM notes_cte",
    }).success).toBe(true);
  });

  test("rejects query parameter payloads above the fixed input bound", () => {
    const operation = definition("tinycloud.sql.query");
    expect(operation.input.safeParse({
      space: "applications",
      database: "notes",
      sql: "SELECT ?",
      params: ["x".repeat(4 * 1024 * 1024 + 1)],
    }).success).toBe(false);
  });

  test("rejects protected spaces before planning or execution", async () => {
    let handles = 0;
    const runtime = context({
      sqlForSpace() {
        handles += 1;
        throw new Error("must not execute");
      },
    });

    for (const [id, input] of [
      ["tinycloud.sql.schema.inspect", { space: "account", database: "account" }],
      ["tinycloud.sql.query", {
        space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:secrets",
        database: "vault",
        sql: "SELECT 1",
      }],
    ] as const) {
      const operation = definition(id);
      const parsed = operation.input.parse(input);
      await expect(operation.authority(runtime, parsed)).rejects.toMatchObject({
        operationError: { code: "INPUT_INVALID" },
      });
      expect(await operation.execute(runtime, parsed)).toMatchObject({
        status: "error",
        error: { code: "INPUT_INVALID" },
      });
    }
    expect(handles).toBe(0);
  });

  test("rejects oversized and unsafe results without truncating them", async () => {
    const operation = definition("tinycloud.sql.query");
    const input = operation.input.parse({
      space: "applications",
      database: "notes",
      sql: "SELECT value FROM notes",
      maxRows: 1,
      maxBytes: 1024,
    });

    const oversized = await operation.execute(context(sqlNode(async () => ({
      ok: true,
      data: { columns: ["value"], rows: [[1], [2]], rowCount: 2 },
    }))), input);
    expect(oversized).toMatchObject({
      status: "error",
      error: { code: "SQL_RESULT_LIMIT_EXCEEDED" },
    });

    const unsafe = await operation.execute(context(sqlNode(async () => ({
      ok: true,
      data: {
        columns: ["value"],
        rows: [[Number.MAX_SAFE_INTEGER + 1]],
        rowCount: 1,
      },
    }))), { ...input, maxRows: 10 });
    expect(unsafe).toMatchObject({
      status: "error",
      error: { code: "SQL_VALUE_UNSAFE" },
    });
  });

  test("maps the node HTTP 413 service error to the stable result-limit error", async () => {
    const operation = definition("tinycloud.sql.query");
    const input = operation.input.parse({
      space: "applications",
      database: "notes",
      sql: "SELECT value FROM notes",
    });
    const result = await operation.execute(context(sqlNode(async () => ({
      ok: false,
      error: { code: "SQL_RESPONSE_TOO_LARGE" },
    }))), input);
    expect(result).toMatchObject({
      status: "error",
      error: { code: "SQL_RESULT_LIMIT_EXCEEDED" },
    });
  });

  test("classifies real SQL service HTTP refusals separately from retryable node errors", async () => {
    for (const [id, raw] of [
      ["tinycloud.sql.query", { space: "applications", database: "notes", sql: "SELECT value FROM notes" }],
      ["tinycloud.sql.schema.inspect", { space: "applications", database: "notes" }],
    ] as const) {
      const operation = definition(id);
      const input = operation.input.parse(raw);
      for (const [status, body, expected, retryable] of [
        [401, "Unauthorized", "AUTH_REQUIRED", false],
        [401, "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:applications/sql/notes / tinycloud.sql/read", "PERMISSION_DENIED", false],
        [401, "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:applications/sql/notes / tinycloud.kv/get", "AUTH_REQUIRED", false],
        [403, "Forbidden: private SQL", "PERMISSION_DENIED", false],
        [502, "upstream private SQL", "NODE_ERROR", true],
      ] as const) {
        const service = new SQLService();
        service.initialize({
          session: { delegationHeader: { Authorization: "Bearer fixture" }, spaceId: OWNER_APPLICATIONS },
          isAuthenticated: true,
          invoke: () => ({ Authorization: "Bearer fixture" }),
          fetch: async () => new Response(body, { status }),
          hosts: ["https://node.tinycloud.test"],
          emit: () => undefined,
        } as unknown as Parameters<SQLService["initialize"]>[0]);
        const result = await operation.execute(context({ sqlForSpace: () => service }), input);
        expect(result).toMatchObject({ status: "error", error: { code: expected, retryable } });
        expect(JSON.stringify(result)).not.toContain("private SQL");
        expect(JSON.stringify(result)).not.toContain("tinycloud:pkh:eip155:1:0xabc:applications/notes");
      }
    }
  });

  test("keeps typed SQL authorization through thrown wrappers without reclassifying outer 5xx", async () => {
    const operation = definition("tinycloud.sql.query");
    const input = operation.input.parse({ space: "applications", database: "notes", sql: "SELECT value FROM notes" });
    for (const [outer, cause, expected, retryable] of [
      [undefined, { statusCode: 401 }, "AUTH_REQUIRED", false],
      [undefined, { service: "sql", meta: { status: 401, resource: "tinycloud:pkh:eip155:1:0xabc:applications/sql/notes", requiredAction: "tinycloud.sql/read" } }, "PERMISSION_DENIED", false],
      [undefined, { meta: { status: 403 } }, "PERMISSION_DENIED", false],
      [{ status: 502 }, { status: 401 }, "NODE_ERROR", true],
    ] as const) {
      const thrown = Object.assign(new Error("private transport response"), { ...outer, cause });
      const result = await operation.execute(context(sqlNode(async () => { throw thrown; })), input);
      expect(result).toMatchObject({ status: "error", error: { code: expected, retryable } });
      expect(JSON.stringify(result)).not.toContain("private transport response");
      expect(JSON.stringify(result)).not.toContain("tinycloud:pkh:eip155:1:0xabc:applications/notes");
    }
  });
});

describe("SQLite DML operation", () => {
  test("plans disclosed exact-database write authority and executes parameterized DML", async () => {
    const calls: unknown[][] = [];
    const node = sqlWriteNode(async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, data: { changes: 1, lastInsertRowId: 42 } };
    });
    const operation = definition("tinycloud.sql.execute");
    const input = operation.input.parse({
      space: "applications",
      database: "com.example.notes/data.sqlite",
      sql: "INSERT INTO notes (body, payload) VALUES (?, ?)",
      params: ["hello", { type: "blob", base64: "AH//" }],
      acknowledgeDatabaseWideAuthority: true,
    });

    expect(await operation.authority(context(node), input)).toEqual([{
      service: "tinycloud.sql",
      space: OWNER_APPLICATIONS,
      path: "com.example.notes/data.sqlite",
      actions: ["tinycloud.sql/write"],
      description: expect.stringContaining("full read/write/schema mutation authority"),
    }]);
    expect(await operation.execute(context(node), input)).toEqual({
      status: "ok",
      output: {
        space: OWNER_APPLICATIONS,
        database: "com.example.notes/data.sqlite",
        statementType: "insert",
        changes: 1,
        lastInsertRowId: 42,
        authorityNotice: expect.stringContaining("full read/write/schema mutation authority"),
      },
    });
    expect(calls).toEqual([[
      "INSERT INTO notes (body, payload) VALUES (?, ?)",
      ["hello", new Uint8Array([0, 127, 255])],
    ]]);
  });

  test("accepts only one positional-parameterized INSERT, UPDATE, or DELETE", () => {
    const operation = definition("tinycloud.sql.execute");
    const base = {
      space: "applications",
      database: "notes",
      acknowledgeDatabaseWideAuthority: true,
    };
    for (const [sql, params] of [
      ["INSERT INTO notes (body) VALUES (?)", ["hello"]],
      ["UPDATE notes SET body = ? WHERE id = ?", ["changed", 1]],
      ["DELETE FROM notes WHERE id = ?", [1]],
    ] as const) {
      expect(operation.input.safeParse({ ...base, sql, params }).success).toBe(true);
    }

    for (const [sql, params] of [
      ["SELECT * FROM notes WHERE id = ?", [1]],
      ["CREATE TABLE hidden (id INTEGER)", [1]],
      ["PRAGMA table_info(?)", ["notes"]],
      ["EXPLAIN DELETE FROM notes WHERE id = ?", [1]],
      ["DELETE FROM notes WHERE id = ?; DELETE FROM notes WHERE id = ?", [1, 2]],
      ["WITH doomed AS (SELECT ?) DELETE FROM notes WHERE id IN (SELECT * FROM doomed)", [1]],
      ["INSERT INTO notes (body) VALUES ('literal')", []],
      ["UPDATE notes SET body = ? WHERE id = ?", ["missing-id"]],
    ] as const) {
      expect(operation.input.safeParse({ ...base, sql, params }).success).toBe(false);
    }
    expect(operation.input.safeParse({
      ...base,
      sql: "DELETE FROM notes WHERE id = ?",
      params: [1],
      acknowledgeDatabaseWideAuthority: false,
    }).success).toBe(false);
  });

  test("rejects protected spaces before write authority planning or execution", async () => {
    let handles = 0;
    const runtime = context({
      sqlForSpace() {
        handles += 1;
        throw new Error("must not execute");
      },
    });
    const operation = definition("tinycloud.sql.execute");
    const parsed = operation.input.parse({
      space: "account",
      database: "account",
      sql: "DELETE FROM sessions WHERE id = ?",
      params: [1],
      acknowledgeDatabaseWideAuthority: true,
    });
    await expect(operation.authority(runtime, parsed)).rejects.toMatchObject({
      operationError: { code: "INPUT_INVALID" },
    });
    expect(await operation.execute(runtime, parsed)).toMatchObject({
      status: "error",
      error: { code: "INPUT_INVALID" },
    });
    expect(handles).toBe(0);
  });

  test("rejects unsafe mutation metadata", async () => {
    const operation = definition("tinycloud.sql.execute");
    const input = operation.input.parse({
      space: "applications",
      database: "notes",
      sql: "DELETE FROM notes WHERE id = ?",
      params: [1],
      acknowledgeDatabaseWideAuthority: true,
    });
    for (const data of [
      { changes: Number.MAX_SAFE_INTEGER + 1, lastInsertRowId: null },
      { changes: 1, lastInsertRowId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(await operation.execute(context(sqlWriteNode(async () => ({
        ok: true,
        data,
      }))), input)).toMatchObject({
        status: "error",
        error: { code: "SQL_VALUE_UNSAFE" },
      });
    }
  });

  test("never automatically retries a failed non-idempotent SQL mutation", async () => {
    const operation = definition("tinycloud.sql.execute");
    const input = operation.input.parse({
      space: "applications",
      database: "notes",
      sql: "DELETE FROM notes WHERE id = ?",
      params: [1],
      acknowledgeDatabaseWideAuthority: true,
    });
    for (const error of [
      { code: "SQL_ERROR", meta: { status: 400 } },
      { code: "NETWORK_ERROR", meta: { status: 503 } },
      { code: "SQL_QUOTA_EXCEEDED", meta: { status: 429 } },
    ] as const) {
      expect(await operation.execute(context(sqlWriteNode(async () => ({
        ok: false,
        error,
      }))), input)).toMatchObject({
        status: "error",
        error: { code: "SQL_EXECUTION_FAILED", retryable: false },
      });
    }
  });

  test("classifies SQL write authorization refusals without retrying uncertain mutations", async () => {
    const operation = definition("tinycloud.sql.execute");
    const input = operation.input.parse({
      space: "applications",
      database: "notes",
      sql: "DELETE FROM notes WHERE id = ?",
      params: [1],
      acknowledgeDatabaseWideAuthority: true,
    });
    for (const [status, body, expected] of [
      [401, "Unauthorized", "AUTH_REQUIRED"],
      [401, "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:applications/sql/notes / tinycloud.sql/write", "PERMISSION_DENIED"],
      [403, "Forbidden: private write", "PERMISSION_DENIED"],
      [502, "private write outcome", "SQL_EXECUTION_FAILED"],
    ] as const) {
      const service = new SQLService();
      service.initialize({
        session: { delegationHeader: { Authorization: "Bearer fixture" }, spaceId: OWNER_APPLICATIONS },
        isAuthenticated: true,
        invoke: () => ({ Authorization: "Bearer fixture" }),
        fetch: async () => new Response(body, { status }),
        hosts: ["https://node.tinycloud.test"],
        emit: () => undefined,
      } as unknown as Parameters<SQLService["initialize"]>[0]);
      const result = await operation.execute(context({ sqlForSpace: () => service }), input);
      expect(result).toMatchObject({ status: "error", error: { code: expected, retryable: false } });
      expect(JSON.stringify(result)).not.toContain("private write");
      expect(JSON.stringify(result)).not.toContain("tinycloud:pkh:eip155:1:0xabc:applications/notes");
    }

    for (const [cause, expected] of [
      [{ status: 401 }, "AUTH_REQUIRED"],
      [{ status: 403 }, "PERMISSION_DENIED"],
      [{ status: 502 }, "SQL_EXECUTION_FAILED"],
      [undefined, "SQL_EXECUTION_FAILED"],
    ] as const) {
      const thrown = Object.assign(new Error("private mutation outcome"), { cause });
      const result = await operation.execute(context(sqlWriteNode(async () => { throw thrown; })), input);
      expect(result).toMatchObject({ status: "error", error: { code: expected, retryable: false } });
      expect(JSON.stringify(result)).not.toContain("private mutation outcome");
    }
  });

  test("reports a storage rejection as a known, non-retryable outcome", async () => {
    const operation = definition("tinycloud.sql.execute");
    const input = operation.input.parse({
      space: "applications",
      database: "notes",
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["x"],
      acknowledgeDatabaseWideAuthority: true,
    });
    for (const error of [
      { code: "STORAGE_QUOTA_EXCEEDED", meta: { status: 402, usedBytes: 155_744, limitBytes: 0 } },
      { code: "STORAGE_LIMIT_REACHED", meta: { status: 413 } },
    ] as const) {
      const result = await operation.execute(context(sqlWriteNode(async () => ({ ok: false, error }))), input);
      expect(result).toMatchObject({
        status: "error",
        error: { code: "STORAGE_QUOTA_EXCEEDED", retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain("outcome is unknown");
      expect(JSON.stringify(result)).not.toContain("155744");
    }
  });
});

function sqlNode(query: (...args: unknown[]) => Promise<unknown>) {
  return {
    sqlForSpace(space: string) {
      expect(space).toBe(OWNER_APPLICATIONS);
      return {
        db(database: string) {
          expect(database.length).toBeGreaterThan(0);
          return { query };
        },
      };
    },
  };
}

function sqlWriteNode(execute: (...args: unknown[]) => Promise<unknown>) {
  return {
    sqlForSpace(space: string) {
      expect(space).toBe(OWNER_APPLICATIONS);
      return {
        db(database: string) {
          expect(database.length).toBeGreaterThan(0);
          return { execute };
        },
      };
    },
  };
}
