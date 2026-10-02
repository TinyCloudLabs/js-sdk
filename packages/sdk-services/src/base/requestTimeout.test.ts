import { afterEach, describe, expect, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
} from "../types";
import { ErrorCodes } from "../types";
import { ServiceContext } from "../context";
import { SQLService } from "../sql/SQLService";
import { KVService } from "../kv/KVService";
import { DuckDbService } from "../duckdb/DuckDbService";

function response(ok: boolean, status: number, body: unknown): FetchResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: { get: () => null },
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    blob: async () => new Blob([text]),
  };
}

/** Settles only when `signal` aborts, rejecting with its reason (as fetch does). */
function untilAborted<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A fetch whose response never arrives, like a dropped `/invoke` response. */
const hangingFetch: IServiceContext["fetch"] = (_url, init) => untilAborted(init?.signal);

/** Counts `abort` listeners that were added to a signal and not yet removed. */
function countAbortListeners(signal: AbortSignal): () => number {
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === "abort") live.add(listener);
    return add(type as "abort", listener as EventListener, options as AddEventListenerOptions);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === "abort") live.delete(listener);
    return remove(type as "abort", listener as EventListener, options as EventListenerOptions);
  }) as AbortSignal["removeEventListener"];
  return () => live.size;
}

/** Tracks timers scheduled through the global setTimeout that are still pending. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function trackTimers(): { scheduled: () => number; pending: () => number } {
  const pending = new Set<unknown>();
  let scheduled = 0;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    scheduled++;
    const id = realSetTimeout(() => {
      pending.delete(id);
      handler(...args);
    }, delay);
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(id);
    realClearTimeout(id);
  }) as typeof clearTimeout;
  return { scheduled: () => scheduled, pending: () => pending.size };
}

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

function createContext(
  fetchImpl: IServiceContext["fetch"],
  abortSignal: AbortSignal = new AbortController().signal,
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
    invoke: () => ({ Authorization: "Bearer signed-invocation" }),
    invokeAny: () => ({ Authorization: "Bearer signed-multi-invocation" }),
    fetch: fetchImpl,
    hosts: ["https://node.tinycloud.xyz"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal,
    retryPolicy: {
      maxAttempts: 1,
      backoff: "none",
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableErrors: [],
    },
  };
}

describe("configured request timeout", () => {
  test("SQL: a hanging /invoke fails with TIMEOUT after config.timeout", async () => {
    let seen: FetchRequestInit | undefined;
    const sql = new SQLService({ timeout: 20 });
    sql.initialize(createContext((url, init) => {
      seen = init;
      return hangingFetch(url, init);
    }));

    const started = Date.now();
    const result = await sql.query("SELECT 1");

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: ErrorCodes.TIMEOUT,
      service: "sql",
      message: "Request timed out after 20ms.",
      meta: { timeoutMs: 20 },
    });
    expect(result.error.cause?.name).toBe("TimeoutError");
    expect(seen?.signal?.aborted).toBe(true);
  });

  test("SQL: the timeout also covers a response body that never finishes", async () => {
    const sql = new SQLService({ timeout: 20 });
    sql.initialize(createContext(async (_url, init) => ({
      ...response(true, 200, {}),
      json: () => untilAborted(init?.signal),
    })));

    const result = await sql.execute("INSERT INTO t VALUES (1)");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.TIMEOUT);
  });

  test("KV: config.timeout applies, and a per-call timeout overrides it", async () => {
    const configured = new KVService({ timeout: 20 });
    configured.initialize(createContext(hangingFetch));
    const fromConfig = await configured.get("key");
    expect(fromConfig.ok).toBe(false);
    if (!fromConfig.ok) {
      expect(fromConfig.error).toMatchObject({
        code: ErrorCodes.TIMEOUT,
        service: "kv",
        meta: { timeoutMs: 20 },
      });
    }

    const overridden = new KVService({ timeout: 60_000 });
    overridden.initialize(createContext(hangingFetch));
    const fromCall = await overridden.put("key", "value", { timeout: 20 });
    expect(fromCall.ok).toBe(false);
    if (!fromCall.ok) {
      expect(fromCall.error).toMatchObject({ code: ErrorCodes.TIMEOUT, meta: { timeoutMs: 20 } });
    }
  });

  test("KV: a per-call timeout of 0 disables the configured timeout", async () => {
    const timers = trackTimers();
    const kv = new KVService({ timeout: 5 });
    kv.initialize(createContext(async () => {
      await Bun.sleep(40);
      return response(true, 200, "value");
    }));

    const result = await kv.get("key", { timeout: 0, raw: true });

    expect(result).toMatchObject({ ok: true, data: { data: "value" } });
    expect(timers.scheduled()).toBe(0);
  });

  test("KV batchPut: a timeout is TIMEOUT and keeps the may-have-dispatched marker", async () => {
    const kv = new KVService({ timeout: 20 });
    kv.initialize(createContext(hangingFetch));

    const result = await kv.batchPut([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.TIMEOUT);
      expect(result.error.meta?.requestMayHaveDispatched).toBe(true);
    }
  });

  test("KV batchPut: a timeout while the 2xx body streams is TIMEOUT and unconfirmed", async () => {
    const kv = new KVService({ timeout: 20 });
    kv.initialize(createContext(async (_url, init) => ({
      ...response(true, 200, {}),
      json: () => untilAborted(init?.signal),
    })));

    const result = await kv.batchPut([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: ErrorCodes.TIMEOUT,
        meta: {
          timeoutMs: 20,
          requestMayHaveDispatched: true,
          responseReceived: true,
          status: 200,
          outcome: "batch-unconfirmed",
        },
      });
    }
  });

  test("DuckDB: config.timeout applies", async () => {
    const duckdb = new DuckDbService({ timeout: 20 });
    duckdb.initialize(createContext(hangingFetch));

    const result = await duckdb.query("SELECT 1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: ErrorCodes.TIMEOUT, service: "duckdb" });
    }
  });
});

describe("aborts other than the timeout", () => {
  test("a caller abort still reports ABORTED when a timeout is configured", async () => {
    const sql = new SQLService({ timeout: 60_000 });
    sql.initialize(createContext(hangingFetch));
    const kv = new KVService({ timeout: 60_000 });
    kv.initialize(createContext(hangingFetch));

    const caller = new AbortController();
    const pendingSql = sql.query("SELECT 1", [], { signal: caller.signal });
    const pendingKv = kv.get("key", { signal: caller.signal });
    caller.abort();

    const [sqlResult, kvResult] = await Promise.all([pendingSql, pendingKv]);
    for (const result of [sqlResult, kvResult]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCodes.ABORTED);
    }
  });

  test("an already-aborted caller signal reports ABORTED", async () => {
    const sql = new SQLService({ timeout: 60_000 });
    sql.initialize(createContext(hangingFetch));

    const result = await sql.query("SELECT 1", [], { signal: AbortSignal.abort() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.ABORTED);
  });

  test("sign-out still aborts in-flight requests with ABORTED", async () => {
    const sql = new SQLService({ timeout: 60_000 });
    sql.initialize(createContext(hangingFetch));

    const pending = sql.query("SELECT 1");
    sql.onSignOut();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.ABORTED);
  });
});

describe("no timeout configured", () => {
  test("a slow request is never aborted and schedules no timer", async () => {
    const timers = trackTimers();
    let seen: FetchRequestInit | undefined;
    const sql = new SQLService();
    sql.initialize(createContext(async (_url, init) => {
      seen = init;
      await Bun.sleep(60);
      return response(true, 200, { columns: [], rows: [], rowCount: 0 });
    }));
    const kv = new KVService();
    kv.initialize(createContext(async () => {
      await Bun.sleep(60);
      return response(true, 200, "value");
    }));

    const [sqlResult, kvResult] = await Promise.all([
      sql.query("SELECT 1"),
      kv.get("key", { raw: true }),
    ]);

    expect(sqlResult.ok).toBe(true);
    expect(kvResult.ok).toBe(true);
    expect(seen?.signal?.aborted).toBe(false);
    expect(timers.scheduled()).toBe(0);
  });

  test("non-positive or out-of-range timeouts are ignored", async () => {
    const timers = trackTimers();
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      const sql = new SQLService({ timeout });
      sql.initialize(createContext(async () =>
        response(true, 200, { columns: [], rows: [], rowCount: 0 })
      ));
      const result = await sql.query("SELECT 1");
      expect(result.ok).toBe(true);
    }
    expect(timers.scheduled()).toBe(0);
  });
});

describe("request signal cleanup", () => {
  test("leaves no pending timers or parent-signal listeners behind", async () => {
    const timers = trackTimers();
    const contextAbort = new AbortController();
    const contextListeners = countAbortListeners(contextAbort.signal);

    let mode: "ok" | "http-error" | "throw" | "hang" = "ok";
    const fetchImpl: IServiceContext["fetch"] = async (url, init) => {
      switch (mode) {
        case "ok":
          return response(true, 200, { columns: [], rows: [], rowCount: 0 });
        case "http-error":
          return response(false, 500, "boom");
        case "throw":
          throw new Error("connection reset");
        case "hang":
          return hangingFetch(url, init);
      }
    };

    const sql = new SQLService({ timeout: 30 });
    sql.initialize(createContext(fetchImpl, contextAbort.signal));
    const serviceListeners = countAbortListeners(
      (sql as unknown as { abortController: AbortController }).abortController.signal,
    );
    const callerAbort = new AbortController();
    const callerListeners = countAbortListeners(callerAbort.signal);

    const outcomes: string[] = [];
    for (const next of ["ok", "http-error", "throw", "hang"] as const) {
      mode = next;
      for (let i = 0; i < 5; i++) {
        const result = await sql.query("SELECT 1", [], { signal: callerAbort.signal });
        outcomes.push(result.ok ? "ok" : result.error.code);
      }
    }

    // A caller abort also releases everything.
    mode = "hang";
    const abortedCaller = new AbortController();
    const pending = sql.query("SELECT 1", [], { signal: abortedCaller.signal });
    abortedCaller.abort();
    outcomes.push(((await pending) as { error: { code: string } }).error.code);

    expect(outcomes).toEqual([
      ...Array(5).fill("ok"),
      ...Array(5).fill(ErrorCodes.NETWORK_ERROR),
      ...Array(5).fill(ErrorCodes.NETWORK_ERROR),
      ...Array(5).fill(ErrorCodes.TIMEOUT),
      ErrorCodes.ABORTED,
    ]);
    expect(timers.scheduled()).toBe(21);
    expect(timers.pending()).toBe(0);
    expect(contextListeners()).toBe(0);
    expect(serviceListeners()).toBe(0);
    expect(callerListeners()).toBe(0);
  });
});

describe("with the platform fetch", () => {
  test("times out a real request whose response or body never arrives", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/invoke") {
          return new Response("not found", { status: 404 });
        }
        if (request.headers.get("x-test-mode") === "stalled-body") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{\"partial\":"));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Promise<Response>(() => undefined);
      },
    });

    try {
      const host = `http://127.0.0.1:${server.port}`;
      const makeContext = (mode: string) => new ServiceContext({
        hosts: [host],
        invoke: () => ({ "x-test-mode": mode }),
        session: {
          delegationHeader: { Authorization: "Bearer test" },
          delegationCid: "bafybeitest",
          spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
          verificationMethod: "did:key:test",
          jwk: {},
        },
      });

      const sql = new SQLService({ timeout: 50 });
      sql.initialize(makeContext("no-response"));
      const kv = new KVService({ timeout: 50 });
      kv.initialize(makeContext("stalled-body"));

      const [sqlResult, kvResult] = await Promise.all([
        sql.query("SELECT 1"),
        kv.get("key"),
      ]);

      for (const result of [sqlResult, kvResult]) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.TIMEOUT);
          expect(result.error.meta?.timeoutMs).toBe(50);
        }
      }
    } finally {
      server.stop(true);
    }
  });
});
