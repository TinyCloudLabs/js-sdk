import { describe, expect, test } from "bun:test";
import type { FetchResponse, IServiceContext } from "./types";
import { ErrorCodes } from "./types";
import { DuckDbService } from "./duckdb/DuckDbService";
import { KVService } from "./kv/KVService";
import { SQLService } from "./sql/SQLService";

// The node's bodies are plain text (tinycloud-node #347): `sql_busy: <stage>: ...`,
// `request_timeout: ...`, `outcome_unknown: ...` and, from 1.20.5,
// `unavailable_retryable: ...`.
const SQL_BUSY = (stage: string) => `sql_busy: ${stage}: the database is busy; retry the request`;
const REQUEST_TIMEOUT = "request_timeout: no change was applied; retry the request";
const OUTCOME_UNKNOWN =
  "outcome_unknown: the write may have been applied; read the database back before retrying";

function nodeResponse(status: number, body: string, headers: Record<string, string> = {}): FetchResponse {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => JSON.parse(body),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    blob: async () => new Blob([body]),
  };
}

function context(fetchImpl: IServiceContext["fetch"]): IServiceContext {
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

function sql(fetchImpl: IServiceContext["fetch"]) {
  const service = new SQLService();
  service.initialize(context(fetchImpl));
  return service;
}

function kv(fetchImpl: IServiceContext["fetch"]) {
  const service = new KVService({});
  service.initialize(context(fetchImpl));
  return service;
}

describe("SQL: typed node retry signals", () => {
  test.each(["lock_wait", "hydration", "artifact_transfer", "identity_resolution"])(
    "503 sql_busy: %s is NODE_BUSY with the stage and Retry-After",
    async (stage) => {
      let calls = 0;
      const service = sql(async () => {
        calls++;
        return nodeResponse(503, SQL_BUSY(stage), { "retry-after": "5" });
      });
      const result = await service.query("SELECT 1");
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: ErrorCodes.NODE_BUSY,
          service: "sql",
          meta: { status: 503, stage, retryAfterMs: 5000, retryable: true },
        },
      });
      expect(calls).toBe(1); // no automatic retry
    },
  );

  test("503 request_timeout is REQUEST_TIMEOUT: nothing applied, retry after 1 s", async () => {
    const result = await sql(async () => nodeResponse(503, REQUEST_TIMEOUT, { "retry-after": "1" })).execute(
      "INSERT INTO t VALUES (1)",
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.REQUEST_TIMEOUT, meta: { status: 503, retryAfterMs: 1000, retryable: true } },
    });
  });

  test("503 unavailable_retryable is NODE_BUSY without a stage", async () => {
    const result = await sql(async () =>
      nodeResponse(503, "unavailable_retryable: pool exhausted", { "retry-after": "1" }),
    ).query("SELECT 1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.NODE_BUSY, meta: { retryAfterMs: 1000, retryable: true } },
    });
    if (!result.ok) expect(result.error.meta).not.toHaveProperty("stage");
  });

  test("503 read_audit_busy (no data returned) is NODE_BUSY with Retry-After", async () => {
    const result = await sql(async () =>
      nodeResponse(503, "read_audit_busy: the read audit is backlogged; retry the request", { "retry-after": "5" }),
    ).query("SELECT 1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.NODE_BUSY, meta: { retryAfterMs: 5000, retryable: true } },
    });
  });

  test("500 outcome_unknown is OUTCOME_UNKNOWN, not safely retryable, with no retryAfterMs", async () => {
    const result = await sql(async () => nodeResponse(500, OUTCOME_UNKNOWN)).execute("INSERT INTO t VALUES (1)");
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.OUTCOME_UNKNOWN, meta: { status: 500, retryable: false } },
    });
    if (!result.ok) expect(result.error.meta).not.toHaveProperty("retryAfterMs");
  });

  test("Retry-After is read as whole seconds; anything else is ignored", async () => {
    const run = async (value: string) => {
      const result = await sql(async () => nodeResponse(503, SQL_BUSY("lock_wait"), { "retry-after": value })).query(
        "SELECT 1",
      );
      return result.ok ? undefined : result.error.meta?.retryAfterMs;
    };
    expect(await run("7")).toBe(7000);
    expect(await run("soon")).toBeUndefined();
    expect(await run("-3")).toBeUndefined();
    expect(await run("")).toBeUndefined();
    expect(await run("1.5")).toBeUndefined();
    expect(await run("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });

  test("a bodyless 503 or 500 (node 1.20.6) keeps NETWORK_ERROR with its status", async () => {
    for (const status of [503, 500]) {
      const result = await sql(async () => nodeResponse(status, "")).query("SELECT 1");
      expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR, meta: { status } } });
      if (!result.ok) {
        expect(result.error.meta).not.toHaveProperty("retryAfterMs");
        expect(result.error.meta).not.toHaveProperty("retryable");
      }
    }
  });

  test("a 503 that is not a node retry signal (cutover fence) keeps NETWORK_ERROR", async () => {
    const result = await sql(async () => nodeResponse(503, "database migration in progress")).query("SELECT 1");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR, meta: { status: 503 } } });
  });

  test("a body prefix is not trusted on the wrong status", async () => {
    const result = await sql(async () => nodeResponse(500, SQL_BUSY("lock_wait"))).query("SELECT 1");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR } });
  });

  test("a real transport failure stays NETWORK_ERROR", async () => {
    const result = await sql(async () => {
      throw new TypeError("fetch failed");
    }).query("SELECT 1");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR } });
  });
});

describe("DuckDB: typed node retry signals", () => {
  test("503 request_timeout is REQUEST_TIMEOUT", async () => {
    const service = new DuckDbService();
    service.initialize(context(async () => nodeResponse(503, REQUEST_TIMEOUT, { "retry-after": "1" })));
    const result = await service.query("SELECT 1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.REQUEST_TIMEOUT, service: "duckdb", meta: { retryAfterMs: 1000 } },
    });
  });
});

describe("KV: typed node retry signals", () => {
  test.each([
    ["ifMatch", { ifMatch: '"blake3-old"' }],
    ["ifNoneMatch", { ifNoneMatch: "*" }],
  ] as const)("a conditional put (%s) 503 request_timeout is never KV_CONFLICT", async (_name, options) => {
    const result = await kv(async () => nodeResponse(503, REQUEST_TIMEOUT, { "retry-after": "1" })).put(
      "k",
      "v",
      options,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.REQUEST_TIMEOUT, service: "kv", meta: { status: 503, retryAfterMs: 1000 } },
    });
  });

  test("a conditional put 503 unavailable_retryable is NODE_BUSY, not KV_CONFLICT", async () => {
    const result = await kv(async () =>
      nodeResponse(503, "unavailable_retryable: pool exhausted", { "retry-after": "1" }),
    ).put("k", "v", { ifMatch: '"blake3-old"' });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NODE_BUSY } });
  });

  test("a conditional put on an old node's bodyless 503 is a write failure, not KV_CONFLICT", async () => {
    const result = await kv(async () => nodeResponse(503, "")).put("k", "v", { ifMatch: '"blake3-old"' });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_WRITE_FAILED, meta: { status: 503 } } });
  });

  test("a conditional put 500 outcome_unknown is OUTCOME_UNKNOWN", async () => {
    const result = await kv(async () => nodeResponse(500, OUTCOME_UNKNOWN)).put("k", "v", { ifMatch: '"e"' });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.OUTCOME_UNKNOWN, meta: { retryable: false } } });
  });

  test("a conditional put 412 is still the precondition failure", async () => {
    const result = await kv(async () => nodeResponse(412, "")).put("k", "v", { ifMatch: '"e"' });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_PRECONDITION_FAILED } });
  });

  test("a conditional delete 503 request_timeout is never KV_CONFLICT", async () => {
    const result = await kv(async () => nodeResponse(503, REQUEST_TIMEOUT, { "retry-after": "1" })).delete("k", {
      ifMatch: '"e"',
    });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.REQUEST_TIMEOUT, meta: { retryAfterMs: 1000 } } });
  });

  test("a conditional delete on an old node's bodyless 503 is NETWORK_ERROR, not KV_CONFLICT", async () => {
    const result = await kv(async () => nodeResponse(503, "")).delete("k", { ifMatch: '"e"' });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR, meta: { status: 503 } } });
  });

  test("a read's 503 request_timeout is typed too", async () => {
    const service = kv(async () => nodeResponse(503, REQUEST_TIMEOUT, { "retry-after": "1" }));
    for (const result of [await service.get("k"), await service.head("k"), await service.list()]) {
      expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.REQUEST_TIMEOUT } });
    }
  });
});
