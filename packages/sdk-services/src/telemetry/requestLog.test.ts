import { expect, test } from "bun:test";
import { buildRequestEvent, byteLengthOf, RequestLog, type RawRequest } from "./requestLog";

const base: RawRequest = { durationMs: 4.6, ok: true, at: 1_700_000_000_000 };
const build = (extra: Partial<RawRequest>) => buildRequestEvent({ ...base, ...extra });

test("path drops query and fragment and keeps ordinary segments", () => {
  const event = build({ service: "kv", op: "kv/get", path: "notes/2024/a.txt?x=1#frag" });
  expect(event.path).toBe("notes/2024/a.txt");
});

test("did:key segments are cut to the method prefix", () => {
  const event = build({ service: "kv", op: "kv/get", path: "peers/did:key:z6MkSecretKeyMaterial/x" });
  expect(event.path).toBe("peers/did:key:…/x");
  expect(JSON.stringify(event)).not.toContain("z6MkSecretKeyMaterial");
});

test("JWT-shaped and 0x-prefixed address segments are redacted", () => {
  const jwt = "eyJhbGciOiJFUzI1NiJ9.payload";
  const event = build({ service: "kv", op: "kv/get", path: `tokens/${jwt}/0xDEADBEEF42/z` });
  expect(event.path).toBe("tokens/[redacted]/[redacted]/z");
  expect(JSON.stringify(event)).not.toContain("payload");
  expect(JSON.stringify(event)).not.toContain("DEADBEEF42");
});

test("opaque runs of 32+ chars are redacted only when they mix digits and letters", () => {
  const mixed = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  const letters = "abcdefghijklmnopqrstuvwxyzabcdefghij";
  const event = build({ service: "kv", op: "kv/get", path: `${mixed}/${letters}` });
  expect(event.path).toBe(`[redacted]/${letters}`);
});

test("secrets space reports the literal secrets/ path and no deeper segment", () => {
  const event = build({
    service: "kv",
    op: "kv/get",
    spaceId: "tinycloud:pkh:eip155:1:0xAbCdEf:secrets",
    path: "scoped/feed-api/OPENAI_KEY",
  });
  expect(event.path).toBe("secrets/");
  expect(event.space).toBe("secrets");
  const json = JSON.stringify(event);
  expect(json).not.toContain("scoped");
  expect(json).not.toContain("OPENAI_KEY");
});

test("secrets/ prefix keys report secrets/ even in an ordinary space", () => {
  const event = build({
    service: "kv",
    op: "kv/put",
    spaceId: "tinycloud:pkh:eip155:1:0xAbCdEf:default",
    path: "secrets/scoped/feed-api/OPENAI_KEY",
  });
  expect(event.path).toBe("secrets/");
  expect(event.space).toBe("default");
  expect(JSON.stringify(event)).not.toContain("feed-api");
});

test("vault events report secrets/ regardless of the vault key", () => {
  const event = build({ service: "vault", op: "vault/get", path: "prod/database-url" });
  expect(event.path).toBe("secrets/");
  expect(JSON.stringify(event)).not.toContain("database-url");
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
  expect(build({ attempts: 0 }).attempts).toBe(1);
  expect(build({ attempts: 3 }).attempts).toBe(3);
});

test("ring keeps the newest 500 events in order and drops the oldest", () => {
  const log = new RequestLog();
  for (let i = 0; i < 501; i++) {
    log.record(build({ service: "kv", op: "kv/get", path: `k${i}` }));
  }
  const events = log.snapshot();
  expect(events.length).toBe(500);
  expect(events[0]!.id).toBe(2);
  expect(events[499]!.id).toBe(501);
  expect(events[0]!.path).toBe("k1");
  expect(events[499]!.path).toBe("k500");
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
