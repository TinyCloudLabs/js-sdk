import { expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { invocationMetaOf, observeReplicaReads, RequestLog } from "./telemetry/requestLog";
import type { FetchResponse, ServiceSession } from "./types";

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
    headers: { get: (name) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    blob: async () => new Blob([body]),
    clone: () => response,
  };
  return response;
}

function contextWith(log: RequestLog | undefined, fetch: (url: string, init?: unknown) => Promise<FetchResponse>) {
  return new ServiceContext({
    invoke: (_session, service, path, action) => ({ "x-test": `${service}|${path}|${action}` }),
    hosts: ["https://node.example"],
    fetch: fetch as never,
    requestSink: log,
  });
}

test("a direct fetch records one event with host, bytes from the body, and code ok", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "ok"));
  await context.fetch("https://node.example/kv", { method: "POST", body: "abc" });
  const events = log.snapshot();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    service: "other",
    op: "other",
    path: null,
    host: "node.example",
    bytes: 3,
    attempts: 1,
    ok: true,
    code: "ok",
    source: "network",
  });
});

test("an invoke-signed kv request is labelled kv with its op, path, and space", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "ok"));
  const headers = context.invoke(session, "kv", "notes/a", "tinycloud.kv/get");
  await context.fetch("https://node.example/kv", { method: "POST", headers });
  const [event] = log.snapshot();
  expect(event).toMatchObject({ service: "kv", op: "kv/get", path: "notes/", ok: true, code: "ok" });
  expect(event.space).not.toBe(SPACE);
  expect(JSON.stringify(event)).not.toContain("0x1234");
});

test("a vault key reaches the log as its first segment only", async () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "ok"));
  const headers = context.invoke(session, "vault", "prod/OPENAI_API_KEY", "tinycloud.vault/get");
  await context.fetch("https://node.example/vault", { method: "POST", headers });
  const [event] = log.snapshot();
  expect(event).toMatchObject({ service: "vault", path: "prod/", ok: true });
  expect(JSON.stringify(event)).not.toContain("OPENAI_API_KEY");
});

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

test("replica-sourced replication reads map to kv events; network and none do not", () => {
  const log = new RequestLog();
  const context = contextWith(log, async () => reply(200, "ok"));
  const unsubscribe = observeReplicaReads(context, log);
  const base = { space: SPACE, key: "notes/a", replica: "notes/", reason: "hit", latencyMs: 2, stalenessMs: null, coverage: null, authority: null };
  context.emit("replication.read", { ...base, op: "get", source: "replica", outcome: "found" });
  context.emit("replication.read", { ...base, op: "list", source: "replica", outcome: "not_found" });
  context.emit("replication.read", { ...base, op: "get", source: "network", outcome: "found" });
  context.emit("replication.read", { ...base, op: "get", source: "none", outcome: "error", code: "NETWORK_ERROR" });
  unsubscribe();
  context.emit("replication.read", { ...base, op: "get", source: "replica", outcome: "found" });
  const events = log.snapshot();
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ service: "kv", op: "kv/get", path: "notes/", host: null, bytes: null, durationMs: 2, source: "replica", ok: true, code: "ok" });
  expect(events[1]).toMatchObject({ service: "kv", op: "kv/list", source: "replica", ok: true, code: "KV_NOT_FOUND" });
});

test("developer off: no sink means no invocation metadata and globalThis.fetch is untouched", async () => {
  const before = globalThis.fetch;
  const context = contextWith(undefined, async () => reply(200, "ok"));
  expect(globalThis.fetch).toBe(before);
  const headers = context.invoke(session, "kv", "notes/a", "tinycloud.kv/get");
  expect(invocationMetaOf(headers)).toBeUndefined();
  const response = await context.fetch("https://node.example/kv", { method: "POST", headers });
  expect(response.ok).toBe(true);
});

test("developer off, zero-call proof: with no sink, fetch is the unrecorded transport and a burst passes every response through", async () => {
  const sent: FetchResponse[] = [];
  let calls = 0;
  const context = contextWith(undefined, async () => {
    calls++;
    const response = reply(200, "ok");
    sent.push(response);
    return response;
  });
  expect(context.requestSink).toBeUndefined();
  // Identity, not behaviour: the recording wrapper is never installed, so buildRequestEvent is unreachable.
  expect(context.fetch).toBe(context.unrecordedFetch);

  const received: unknown[] = [];
  for (let i = 0; i < 50; i++) received.push(await context.fetch(`https://node.example/kv/${i}`, { method: "GET" }));
  expect(calls).toBe(50);
  expect(received.every((response, i) => response === sent[i])).toBe(true);
});

function replyWithLength(length: string | null): FetchResponse {
  return { ...reply(200, "ok"), headers: { get: (name) => (name.toLowerCase() === "content-length" ? length : null) } };
}

test("blank or missing Content-Length leaves response bytes unknown, never 0", async () => {
  const log = new RequestLog();
  for (const length of ["", "  ", null]) {
    const context = contextWith(log, async () => replyWithLength(length));
    await context.fetch("https://node.example/kv", { method: "GET" });
  }
  expect(log.snapshot().map((event) => event.bytes)).toEqual([null, null, null]);
});

test("a digit Content-Length is the response byte count, including an explicit 0", async () => {
  const log = new RequestLog();
  for (const length of ["0", "12"]) {
    const context = contextWith(log, async () => replyWithLength(length));
    await context.fetch("https://node.example/kv", { method: "GET" });
  }
  expect(log.snapshot().map((event) => event.bytes)).toEqual([0, 12]);
});

test("a stream body without a known length is recorded as unknown bytes and is not consumed", async () => {
  const log = new RequestLog();
  const stream = new ReadableStream();
  // The runtime accepts a stream body; the init type is narrower, so the cast stays local to this test.
  const body = stream as unknown as string;
  const context = contextWith(log, async () => reply(200, "ok"));
  await context.fetch("https://node.example/kv", { method: "POST", body });
  expect(log.snapshot()[0]!.bytes).toBeNull();
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
