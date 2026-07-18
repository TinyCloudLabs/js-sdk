import { describe, expect, test } from "bun:test";

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
