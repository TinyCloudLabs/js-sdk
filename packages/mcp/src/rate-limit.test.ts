import { describe, expect, test } from "bun:test";

import {
  clientAddress,
  createRateLimiter,
  rateLimitFromEnv,
  rateLimitedToolResult,
  toolClass,
  DEFAULT_RATE_LIMITS,
} from "./rate-limit.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("token bucket", () => {
  test("spends a burst, refuses with a wait, then refills at the configured rate", () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });
    const rule = { perMinute: 60, burst: 3 };
    expect([1, 2, 3].map(() => limiter.take("b", "k", rule).allowed)).toEqual([true, true, true]);
    const refused = limiter.take("b", "k", rule);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1 });
    time.advance(1000);
    expect(limiter.take("b", "k", rule).allowed).toBe(true);
    expect(limiter.take("b", "k", rule).allowed).toBe(false);
  });

  test("keys and buckets are independent, and a refund gives back one call but never past the capacity", () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });
    const rule = { perMinute: 1, burst: 1 };
    expect(limiter.take("read", "alice", rule).allowed).toBe(true);
    expect(limiter.take("read", "alice", rule).allowed).toBe(false);
    expect(limiter.take("read", "bob", rule).allowed).toBe(true);
    expect(limiter.take("write", "alice", rule).allowed).toBe(true);
    limiter.refund("read", "alice", rule);
    expect(limiter.take("read", "alice", rule).allowed).toBe(true);
    expect(limiter.take("read", "alice", rule).allowed).toBe(false);
    limiter.refund("read", "alice", rule);
    limiter.refund("read", "alice", rule);
    expect(limiter.take("read", "alice", rule).allowed).toBe(true);
    expect(limiter.take("read", "alice", rule).allowed).toBe(false);
    limiter.refund("never-spent", "x", rule);
    expect(limiter.take("never-spent", "x", rule).allowed).toBe(true);
  });

  test("never grows past maxKeys", () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now, maxKeys: 2 });
    const rule = { perMinute: 1, burst: 1 };
    limiter.take("b", "a", rule);
    limiter.take("b", "b", rule);
    limiter.take("b", "c", rule);
    // "a" was the least recently used and was evicted, so it starts fresh; "c" is still depleted.
    expect(limiter.take("b", "c", rule).allowed).toBe(false);
    expect(limiter.take("b", "a", rule).allowed).toBe(true);
  });
});

describe("client address", () => {
  const request = (forwarded?: string) => new Request("https://mcp.test/connect", {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  });

  test("takes the entry the trusted proxy appended, never one the client wrote", () => {
    expect(clientAddress(request("1.1.1.1, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientAddress(request("6.6.6.6, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
  });

  test("a missing or too-short header shares one bucket; zero hops turns address limits off", () => {
    expect(clientAddress(request(), 1)).toBe("unknown");
    expect(clientAddress(request("1.1.1.1"), 2)).toBe("unknown");
    expect(clientAddress(request("1.1.1.1"), 0)).toBeUndefined();
  });
});

describe("tool classes and refusals", () => {
  test("connect is its own class, destructive tools write, the rest read", () => {
    expect(toolClass("tinycloud_connect", false)).toBe("connect");
    expect(toolClass("tinycloud_kv_put", true)).toBe("write");
    expect(toolClass("tinycloud_kv_get", false)).toBe("read");
  });

  test("a refused call is a retryable tool error that names the wait, not a schema change", () => {
    const result = rateLimitedToolResult({ limitClass: "read", retryAfterSeconds: 7 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("RATE_LIMITED");
    expect(result.structuredContent.error.retryable).toBe(true);
    expect(JSON.stringify(result)).toContain("7");
  });
});

describe("environment", () => {
  test("is off unless asked for, and a bad value stops startup instead of running unprotected", () => {
    expect(rateLimitFromEnv({})).toBeUndefined();
    expect(rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "off" })).toBeUndefined();
    expect(() => rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "maybe" })).toThrow("on or off");
    expect(() => rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "on", TC_MCP_RATE_LIMIT_READ_PER_MINUTE: "0" })).toThrow("READ_PER_MINUTE");
    expect(() => rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "on", TC_MCP_TRUSTED_PROXY_HOPS: "-1" })).toThrow("TRUSTED_PROXY_HOPS");
  });

  test("turns on with the defaults and applies overrides, capping the burst at the rate", () => {
    expect(rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "on" })).toEqual(DEFAULT_RATE_LIMITS);
    const tuned = rateLimitFromEnv({
      TC_MCP_RATE_LIMIT: "true",
      TC_MCP_RATE_LIMIT_READ_PER_MINUTE: "5",
      TC_MCP_RATE_LIMIT_WRITE_PER_MINUTE: "300",
      TC_MCP_TRUSTED_PROXY_HOPS: "2",
    })!;
    expect(tuned.tools.read).toEqual({ perMinute: 5, burst: 5 });
    expect(tuned.tools.write).toEqual({ perMinute: 300, burst: 10 });
    expect(tuned.trustedProxyHops).toBe(2);
    expect(tuned.tools.connect).toEqual(DEFAULT_RATE_LIMITS.tools.connect);
  });

  test("the address override raises the address burst in proportion above the default, and lowers it as before", () => {
    const ip = (value: string) => rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "on", TC_MCP_RATE_LIMIT_IP_PER_MINUTE: value })!.ip;
    expect(ip("120")).toEqual({ perMinute: 120, burst: 40 });
    expect(ip("61")).toEqual({ perMinute: 61, burst: 20 });
    expect(ip("60")).toEqual({ perMinute: 60, burst: 20 });
    expect(ip("30")).toEqual({ perMinute: 30, burst: 20 });
    expect(ip("5")).toEqual({ perMinute: 5, burst: 5 });
  });
});
