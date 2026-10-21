import { expect, test } from "bun:test";
import { buildRequestEvent, byteLengthOf, declaredLengthOf, observeReplicaReads, RequestLog, type RawRequest } from "./requestLog";
import type { IServiceContext } from "../types";

const base: RawRequest = { durationMs: 4.6, ok: true, at: 1_700_000_000_000 };
const build = (extra: Partial<RawRequest>) => buildRequestEvent({ ...base, ...extra });

test("a key is recorded as its first segment and a slash, never deeper", () => {
  const event = build({ service: "kv", op: "kv/get", path: "notes/2024/a.txt?x=1#frag" });
  expect(event.path).toBe("notes/");
  expect(JSON.stringify(event)).not.toContain("2024");
  expect(JSON.stringify(event)).not.toContain("a.txt");
});

test("a vault key records only its first segment, whatever the key name", () => {
  const event = build({ service: "vault", op: "vault/get", path: "vault/secrets/OPENAI_API_KEY" });
  expect(event.path).toBe("vault/");
  expect(JSON.stringify(event)).not.toContain("OPENAI_API_KEY");
});

test("a slashless key is redacted: it may be the bare secret name", () => {
  const event = build({ service: "vault", op: "vault/get", path: "OPENAI_API_KEY" });
  expect(event.path).toBe("[redacted]");
  expect(JSON.stringify(event)).not.toContain("OPENAI_API_KEY");
});

test("a namespace listed with a trailing slash keeps that slash", () => {
  const event = build({ service: "kv", op: "kv/list", path: "notes/" });
  expect(event.path).toBe("notes/");
});

test("encoded separators, traversal, and leading slashes cannot reach a deeper key", () => {
  expect(build({ service: "vault", op: "vault/get", path: "vault%2Fprod-db-password" }).path).toBe("vault/");
  expect(build({ service: "vault", op: "vault/get", path: "//vault/prod-db-password" }).path).toBe("vault/");
  const traversal = build({ service: "kv", op: "kv/get", path: "%2e%2e/secret-name/x" });
  expect(traversal.path).toBe("[redacted]");
  expect(JSON.stringify(traversal)).not.toContain("secret-name");
});

test("a first segment that is not a plain label is redacted, not echoed", () => {
  const token = "a".repeat(40);
  expect(build({ service: "kv", op: "kv/get", path: `${token}/x` }).path).toBe("[redacted]");
  expect(build({ service: "kv", op: "kv/get", path: "did:key:z6MkSecret/x" }).path).toBe("[redacted]");
  expect(build({ service: "kv", op: "kv/get", path: "100%/x" }).path).toBe("[redacted]");
});

test("the secrets space keeps its tail label and records only the first path segment", () => {
  const event = build({
    service: "kv",
    op: "kv/get",
    spaceId: "tinycloud:pkh:eip155:1:0xAbCdEf:secrets",
    path: "scoped/feed-api/OPENAI_KEY",
  });
  expect(event.path).toBe("scoped/");
  expect(event.space).toBe("secrets");
  const json = JSON.stringify(event);
  expect(json).not.toContain("feed-api");
  expect(json).not.toContain("OPENAI_KEY");
});

test("space id never leaves the log, only its tail label does", () => {
  const event = build({
    service: "kv",
    op: "kv/get",
    spaceId: "tinycloud:pkh:eip155:1:0xAbCdEf0123:photos",
    path: "a",
  });
  expect(event.space).toBe("photos");
  const json = JSON.stringify(event);
  expect(json).not.toContain("pkh");
  expect(json).not.toContain("0xAbCdEf0123");
});

test("a space label that fails the grammar is replaced with the generic label", () => {
  const event = build({ service: "kv", op: "kv/get", spaceId: "tinycloud:pkh:x:Has Spaces" });
  expect(event.space).toBe("space");
});

test("host keeps only host and port; userinfo, query and fragment are dropped", () => {
  const event = build({
    service: "kv",
    op: "kv/get",
    url: "https://user:pass@node.example:8443/kv/get?token=abc#frag",
  });
  expect(event.host).toBe("node.example:8443");
  const json = JSON.stringify(event);
  expect(json).not.toContain("user");
  expect(json).not.toContain("pass");
  expect(json).not.toContain("token=abc");
});

test("unparseable URL yields a null host", () => {
  expect(build({ service: "kv", op: "kv/get", url: "not a url" }).host).toBeNull();
});

test("unknown service, op, and code collapse to fixed fallbacks", () => {
  const event = build({ service: "bogus", op: "kv/get/extra", code: "lower case" });
  expect(event.service).toBe("other");
  expect(event.op).toBe("other");
  expect(event.code).toBe("ERROR");
  expect(event.ok).toBe(true);
});

test("valid HTTP and error-shaped codes are kept", () => {
  expect(build({ service: "kv", op: "kv/get", ok: false, code: "HTTP_503" }).code).toBe("HTTP_503");
  expect(build({ service: "kv", op: "kv/get", ok: false, code: "KV_NOT_FOUND" }).code).toBe(
    "KV_NOT_FOUND",
  );
});

test("unknown source is reported as network, replica is kept", () => {
  expect(build({ source: "replica" }).source).toBe("replica");
  expect(build({ source: "something" }).source).toBe("network");
});

test("fields outside the allowlist never reach the event", () => {
  const leaking = {
    ...base,
    service: "kv",
    op: "kv/get",
    headers: { authorization: "Bearer secret-token" },
    body: "value-body",
    errorMessage: "stack at /internal/path",
  } as RawRequest;
  const json = JSON.stringify(buildRequestEvent(leaking));
  expect(json).not.toContain("secret-token");
  expect(json).not.toContain("value-body");
  expect(json).not.toContain("internal");
});

test("byte length is UTF-8 for strings and null when unknown, never 0", () => {
  expect(byteLengthOf("é")).toBe(2);
  expect(byteLengthOf(new ArrayBuffer(7))).toBe(7);
  expect(byteLengthOf(new Uint8Array(3))).toBe(3);
  expect(byteLengthOf(new Blob(["abcd"]))).toBe(4);
  expect(byteLengthOf({ not: "a body" })).toBeNull();
  expect(byteLengthOf(undefined)).toBeNull();
  expect(build({ bytes: null }).bytes).toBeNull();
  expect(build({ bytes: -1 }).bytes).toBeNull();
});

test("duration is rounded and clamped at zero; attempts floor at one", () => {
  expect(build({ durationMs: 4.6 }).durationMs).toBe(5);
  expect(build({ durationMs: -3 }).durationMs).toBe(0);
  expect(build({ durationMs: null }).durationMs).toBeNull();
  expect(build({ durationMs: Number.NaN }).durationMs).toBeNull();
  expect(build({ attempts: 0 }).attempts).toBe(1);
  expect(build({ attempts: 3 }).attempts).toBe(3);
});

test("ring keeps the newest 500 events in order and drops the oldest", () => {
  const log = new RequestLog();
  for (let i = 0; i < 501; i++) {
    log.record(build({ service: "kv", op: "kv/get", path: `k${i}/x` }));
  }
  const events = log.snapshot();
  expect(events.length).toBe(500);
  expect(events[0]!.id).toBe(2);
  expect(events[499]!.id).toBe(501);
  expect(events[0]!.path).toBe("k1/");
  expect(events[499]!.path).toBe("k500/");
});

test("snapshot is a copy; mutating it does not change the log", () => {
  const log = new RequestLog();
  log.record(build({ service: "kv", op: "kv/get" }));
  const copy = log.snapshot() as unknown[];
  copy.length = 0;
  expect(log.snapshot().length).toBe(1);
});

test("a throwing subscriber does not stop other subscribers or the record call", () => {
  const log = new RequestLog();
  const seen: number[] = [];
  log.subscribe(() => {
    throw new Error("boom");
  });
  const unsubscribe = log.subscribe((e) => seen.push(e.id));
  expect(() => log.record(build({ service: "kv", op: "kv/get" }))).not.toThrow();
  expect(seen).toEqual([1]);
  unsubscribe();
  log.record(build({ service: "kv", op: "kv/get" }));
  expect(seen).toEqual([1]);
});

test("clear empties the ring, fires onClear, and keeps ids increasing", () => {
  const log = new RequestLog();
  let cleared = 0;
  log.onClear(() => {
    throw new Error("isolated");
  });
  log.onClear(() => {
    cleared++;
  });
  log.record(build({ service: "kv", op: "kv/get" }));
  log.clear();
  expect(log.snapshot()).toEqual([]);
  expect(cleared).toBe(1);
  log.record(build({ service: "kv", op: "kv/get" }));
  expect(log.snapshot()[0]!.id).toBe(2);
});

test("declared Content-Length is a byte count only for plain digits", () => {
  expect(declaredLengthOf("0")).toBe(0);
  expect(declaredLengthOf(" 42 ")).toBe(42);
  expect(declaredLengthOf("")).toBeNull();
  expect(declaredLengthOf("   ")).toBeNull();
  expect(declaredLengthOf("1e3")).toBeNull();
  expect(declaredLengthOf("-1")).toBeNull();
  expect(declaredLengthOf("12abc")).toBeNull();
  expect(declaredLengthOf(null)).toBeNull();
  expect(declaredLengthOf(undefined)).toBeNull();
});

test("observeReplicaReads records replica-served reads and ignores network and none reads", () => {
  const handlers: Array<(data: unknown) => void> = [];
  // observeReplicaReads only subscribes through `on`; this stub captures the handler.
  const context = {
    on: (_event: string, handler: (data: unknown) => void) => {
      handlers.push(handler);
      return () => {};
    },
  } as unknown as IServiceContext;
  const log = new RequestLog();
  observeReplicaReads(context, log);

  const emit = (source: string, outcome: string) =>
    handlers.forEach((handler) =>
      handler({ op: "get", space: "space:a", key: "notes/x", source, outcome, latencyMs: 3 }),
    );
  emit("network", "hit");
  emit("none", "miss");
  emit("replica", "hit");

  const rows = log.snapshot();
  expect(rows.map((row) => row.source)).toEqual(["replica"]);
  expect(rows[0]?.service).toBe("kv");
});

test("a replica read without latency records a null duration, never 0", () => {
  const handlers: Array<(data: unknown) => void> = [];
  const context = {
    on: (_event: string, handler: (data: unknown) => void) => {
      handlers.push(handler);
      return () => {};
    },
  } as unknown as IServiceContext;
  const log = new RequestLog();
  observeReplicaReads(context, log);

  handlers.forEach((handler) => handler({ op: "get", space: "space:a", key: "notes/x", source: "replica", outcome: "hit" }));
  handlers.forEach((handler) => handler({ op: "get", space: "space:a", key: "notes/x", source: "replica", outcome: "hit", latencyMs: 3 }));

  expect(log.snapshot().map((row) => row.durationMs)).toEqual([null, 3]);
});
