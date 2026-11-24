import { describe, expect, test } from "bun:test";
import type { FetchResponse, IServiceContext } from "./types";
import { ErrorCodes } from "./types";
import { DuckDbService } from "./duckdb/DuckDbService";
import { SQLService } from "./sql/SQLService";
import { DATABASE_SIZE_LIMIT_MESSAGE, DATABASE_TOO_LARGE_TO_OPEN_MESSAGE } from "./errors";

// TC-3354: the node's 507 bodies, verbatim (tinycloud-node `sql/types.rs`,
// `duckdb/types.rs`). SQL and DuckDB share the `sql_database_size_limit` token.
const WRITE_TOO_LARGE =
  "sql_database_size_limit: the write would exceed the database size limit; no change was applied";
const TOO_LARGE_TO_OPEN =
  "sql_database_size_limit: the database is larger than this node loads; no change was applied";
const DISK_HEADROOM = "duckdb_disk_headroom: The node is short of disk space for this write";

function nodeResponse(status: number, body: string): FetchResponse {
  return {
    ok: false,
    status,
    statusText: "Insufficient Storage",
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    blob: async () => new Blob([body]),
  };
}

function context(body: string): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: () => ({ Authorization: "Bearer signed-invocation" }),
    invokeAny: () => ({ Authorization: "Bearer signed-multi-invocation" }),
    fetch: async () => nodeResponse(507, body),
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
      retryableErrors: [ErrorCodes.NODE_BUSY, ErrorCodes.REQUEST_TIMEOUT],
    },
  };
}

function sql(body: string) {
  const service = new SQLService();
  service.initialize(context(body));
  return service;
}

function duckdb(body: string) {
  const service = new DuckDbService();
  service.initialize(context(body));
  return service;
}

describe("507 sql_database_size_limit is DATABASE_SIZE_LIMIT, not a network error", () => {
  test("SQL: a write past the database size limit", async () => {
    const result = await sql(WRITE_TOO_LARGE).execute("INSERT INTO t VALUES (1)");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: ErrorCodes.DATABASE_SIZE_LIMIT,
        service: "sql",
        message: DATABASE_SIZE_LIMIT_MESSAGE,
        meta: { status: 507, retryable: false },
      },
    });
  });

  test("SQL: a database too large to open", async () => {
    const result = await sql(TOO_LARGE_TO_OPEN).query("SELECT 1");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: ErrorCodes.DATABASE_SIZE_LIMIT,
        message: DATABASE_TOO_LARGE_TO_OPEN_MESSAGE,
        meta: { status: 507, retryable: false },
      },
    });
  });

  test("DuckDB: a write past the database size limit", async () => {
    const result = await duckdb(WRITE_TOO_LARGE).execute("INSERT INTO t VALUES (1)");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: ErrorCodes.DATABASE_SIZE_LIMIT,
        service: "duckdb",
        message: DATABASE_SIZE_LIMIT_MESSAGE,
        meta: { status: 507, retryable: false },
      },
    });
  });

  test("DuckDB: a database too large to open", async () => {
    const result = await duckdb(TOO_LARGE_TO_OPEN).query("SELECT 1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.DATABASE_SIZE_LIMIT, message: DATABASE_TOO_LARGE_TO_OPEN_MESSAGE },
    });
  });

  test("DuckDB: 507 duckdb_disk_headroom is the node's disk, not this database", async () => {
    const result = await duckdb(DISK_HEADROOM).execute("INSERT INTO t VALUES (1)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe(ErrorCodes.DATABASE_SIZE_LIMIT);
  });
});
