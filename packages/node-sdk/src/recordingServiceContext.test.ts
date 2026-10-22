import { expect, test } from "bun:test";
import { ServiceContext, type FetchResponse, type ServiceSession } from "@tinycloud/sdk-services";
import { invocationMetaOf, RequestLog } from "@tinycloud/sdk-services/telemetry/requestLog";
import { createServiceContext } from "./recordingServiceContext";
import { unrecordedFetchOf } from "./recordingRegistry";

const SPACE = "tinycloud:pkh:eip155:1:0x1234:default";
const session = {
  spaceId: SPACE,
  delegationHeader: {},
  delegationCid: "cid",
  verificationMethod: "did:key:z6Mk",
  jwk: {},
} as unknown as ServiceSession;

const BUSY = "sql_busy: begin: database is locked";

function reply(status: number, body: string, retryAfter?: string): FetchResponse {
  const response: FetchResponse = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (name) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    blob: async () => new Blob([body]),
    clone: () => response,
  };
  return response;
}

function contextWith(log: RequestLog | undefined, fetch: (url: string, init?: unknown) => Promise<FetchResponse>) {
  return createServiceContext({
    invoke: (_session, service, path, action) => ({ "x-test": `${service}|${path}|${action}` }),
    hosts: ["https://node.example"],
    fetch: fetch as never,
    requestSink: log,
  });
}

test("a retried invokeWithRetry produces exactly one event with the attempt count", async () => {
  const log = new RequestLog();
  let calls = 0;
  const context = contextWith(log, async () => {
    calls++;
    return calls === 1 ? reply(503, BUSY, "0") : reply(200, "ok");
  });
  const headers = context.invoke(session, "kv", "notes/a", "tinycloud.kv/put");
  const response = await context.invokeWithRetry("https://node.example/kv", () => ({ method: "POST", headers }));
  expect(response.ok).toBe(true);
  expect(calls).toBe(2);
  const events = log.snapshot();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ service: "kv", op: "kv/put", attempts: 2, ok: true, code: "ok" });
});

test("a failed response is coded HTTP_<status> and a thrown fetch is coded ERROR", async () => {
  const log = new RequestLog();
  const failing = contextWith(log, async () => reply(404, "nope"));
  await failing.fetch("https://node.example/x", { method: "GET" });
  const thrower = contextWith(log, async () => {
    throw new Error("socket reset with secret token");
  });
  await expect(thrower.fetch("https://node.example/x", { method: "GET" })).rejects.toThrow();
  const [http, thrown] = log.snapshot();
  expect(http).toMatchObject({ ok: false, code: "HTTP_404" });
  expect(thrown).toMatchObject({ ok: false, code: "ERROR", bytes: null });
  expect(JSON.stringify(log.snapshot())).not.toContain("secret token");
});

test("developer off: no sink leaves requestSink unset, no invocation metadata, and globalThis.fetch untouched", async () => {
  const before = globalThis.fetch;
  const context = contextWith(undefined, async () => reply(200, "ok"));
  expect(context.constructor).toBe(ServiceContext);
  expect(globalThis.fetch).toBe(before);
  const headers = context.invoke(session, "kv", "notes/a", "tinycloud.kv/get");
  expect(invocationMetaOf(headers)).toBeUndefined();
  const response = await context.fetch("https://node.example/kv", { method: "POST", headers });
  expect(response.ok).toBe(true);
});

test("developer off: a plain context passes every response through unchanged", async () => {
  const sent: FetchResponse[] = [];
  let calls = 0;
  const context = contextWith(undefined, async () => {
    calls++;
    const response = reply(200, "ok");
    sent.push(response);
    return response;
  });
  // Identity: with no sink the caller's fetch is the transport, so no recording wrapper runs.
  expect(context.constructor).toBe(ServiceContext);

  const received: unknown[] = [];
  for (let i = 0; i < 50; i++) received.push(await context.fetch(`https://node.example/kv/${i}`, { method: "GET" }));
  expect(calls).toBe(50);
  expect(received.every((response, i) => response === sent[i])).toBe(true);
});

test("developer off: a _fetch override reaches the transport and the retry loop", async () => {
  // The real transport must never run: the override below answers every attempt.
  const context = contextWith(undefined, async () => {
    throw new Error("real transport ran");
  });
  let overrideCalls = 0;
  // Test-only seam: `_fetch` is the call-time override point; the cast stays on this named const.
  const seam = context as unknown as { _fetch: (url: string, init?: unknown) => Promise<FetchResponse> };
  seam._fetch = async () => {
    overrideCalls += 1;
    return reply(200, "ok");
  };
  const direct = await unrecordedFetchOf(context)("https://node.example/kv", { method: "POST" });
  expect(direct.ok).toBe(true);
  const retried = await context.invokeWithRetry("https://node.example/invoke", () => ({ method: "POST" }));
  expect(retried.ok).toBe(true);
  expect(overrideCalls).toBe(2);
});

test("a stream body is recorded without being consumed", async () => {
  const log = new RequestLog();
  const stream = new ReadableStream();
  // The runtime accepts a stream body; the init type is narrower, so the cast stays local to this test.
  const body = stream as unknown as string;
  const context = contextWith(log, async () => reply(200, "ok"));
  await context.fetch("https://node.example/kv", { method: "POST", body });
  expect(log.snapshot()).toHaveLength(1);
  expect(stream.locked).toBe(false);
});

test("attempts counts every HTTP attempt in a retry loop", async () => {
  const log = new RequestLog();
  const script = [() => reply(503, BUSY, "0"), () => reply(503, BUSY, "0"), () => reply(200, "ok")];
  let calls = 0;
  const context = contextWith(log, async () => script[calls++]!());
  await context.invokeWithRetry("https://node.example/invoke", () => ({ method: "POST" }));
  expect(calls).toBe(3);
  expect(log.snapshot().map((event) => [event.attempts, event.code])).toEqual([[3, "ok"]]);
});

test("an attempt that throws still counts toward attempts", async () => {
  const log = new RequestLog();
  let calls = 0;
  const context = contextWith(log, async () => {
    calls += 1;
    if (calls === 1) return reply(503, BUSY, "0");
    throw new Error("socket reset");
  });
  await expect(
    context.invokeWithRetry("https://node.example/invoke", () => ({ method: "POST" })),
  ).rejects.toThrow("socket reset");
  expect(calls).toBe(2);
  expect(log.snapshot().map((event) => [event.attempts, event.code])).toEqual([[2, "ERROR"]]);
});

const SYNC = "tinycloud.kv/sync";

test("replication rows are service sync with path and space dropped and no key or prefix text", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "{}"));
  await context.fetch("https://node.example/info", { method: "GET" });
  const headers = context.invoke(session, "kv", "notes/secret-key", SYNC);
  await context.invokeWithRetry("https://node.example/invoke", () => ({
    method: "POST",
    headers,
    body: "notes/secret-key payload",
  }));
  const rows = log.snapshot();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row).toMatchObject({ service: "sync", path: null, space: null, host: "node.example" });
  }
  const text = JSON.stringify(rows);
  expect(text).not.toContain("notes");
  expect(text).not.toContain("secret-key");
  expect(text).not.toContain("payload");
});

test("a replication cycle records exactly one row per HTTP attempt counted at the transport", async () => {
  const log = new RequestLog();
  let transportCalls = 0;
  let invokeCalls = 0;
  const context = contextWith(log, async (url) => {
    transportCalls += 1;
    if (url.endsWith("/info")) return reply(200, "{}");
    invokeCalls += 1;
    return invokeCalls === 1 ? reply(503, BUSY, "0") : reply(200, "{}");
  });
  const cycle = async () => {
    await context.fetch("https://node.example/info", { method: "GET" });
    const headers = context.invoke(session, "kv", "notes/", SYNC);
    await context.invokeWithRetry("https://node.example/invoke", () => ({ method: "GET", headers }));
  };
  await cycle();
  await cycle();
  const rows = log.snapshot();
  expect(rows.map((row) => [row.op, row.attempts])).toEqual([
    ["sync/info", 1],
    ["kv/sync", 2],
    ["sync/info", 1],
    ["kv/sync", 1],
  ]);
  expect(rows.reduce((total, row) => total + row.attempts, 0)).toBe(transportCalls);
});

test("user kv calls and user requests to the same host are never relabelled sync", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "{}"));
  const listHeaders = context.invoke(session, "kv", "notes/secret", "tinycloud.kv/list");
  await context.invokeWithRetry("https://node.example/invoke", () => ({ method: "POST", headers: listHeaders }));
  const getHeaders = context.invoke(session, "kv", "notes/secret", "tinycloud.kv/get");
  await context.invokeWithRetry("https://node.example/invoke", () => ({ method: "POST", headers: getHeaders }));
  await context.fetch("https://node.example/kv/list?prefix=notes/secret", { method: "GET" });
  await context.fetch("https://node.example/info/notes/secret", { method: "GET" });
  const rows = log.snapshot();
  expect(rows.map((row) => [row.service, row.op])).toEqual([
    ["kv", "kv/list"],
    ["kv", "kv/get"],
    ["other", "other"],
    ["other", "other"],
  ]);
});

test("a user kv get with meta is never relabelled sync, even when its url ends in /info", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "{}"));
  const headers = context.invoke(session, "kv", "info", "tinycloud.kv/get");
  await context.invokeWithRetry("https://node.example/info", () => ({ method: "POST", headers }));
  const [row] = log.snapshot();
  expect(row).toMatchObject({ service: "kv", op: "kv/get" });
});

test("a meta-less plain fetch to <host>/info is sync/info with host only", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "{}"));
  await context.fetch("https://node.example/info", { method: "GET" });
  const [row] = log.snapshot();
  expect(row).toMatchObject({ service: "sync", op: "sync/info", path: null, space: null, host: "node.example" });
});

test("a sync-looking /info URL from a plain fetch cannot smuggle path, space, or query text into its row", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "{}"));
  await context.fetch(
    "https://node.example/info?prefix=notes/secret-key&space=tinycloud:pkh:eip155:1:0x1234:default",
    { method: "GET" },
  );
  const [row] = log.snapshot();
  expect(row).toMatchObject({ service: "sync", op: "sync/info", path: null, space: null, host: "node.example" });
  const text = JSON.stringify(row);
  expect(text).not.toContain("notes");
  expect(text).not.toContain("secret-key");
  expect(text).not.toContain("0x1234");
});
