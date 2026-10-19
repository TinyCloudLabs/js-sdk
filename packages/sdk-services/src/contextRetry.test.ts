import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { ServiceContext } from "./context";
import type { FetchResponse, RetryPolicy } from "./types";

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

/** A fake node answering from a script, one entry per request; the last repeats. */
function fakeNode(script: Array<() => FetchResponse>) {
  const calls: number[] = [];
  const fetch = async () => {
    calls.push(Date.now());
    return script[Math.min(calls.length, script.length) - 1]();
  };
  return { calls, fetch };
}

function contextFor(fetch: () => Promise<FetchResponse>, retryPolicy?: Partial<RetryPolicy>) {
  return new ServiceContext({ invoke: () => ({}), hosts: ["https://node"], fetch, retryPolicy });
}

/** Advance fake time in 1 ms steps, flushing promise continuations between steps. */
async function advance(ms: number) {
  const flush = async () => { for (let j = 0; j < 10; j++) await Promise.resolve(); };
  await flush(); // let the pending request reach its first wait at the current time
  for (let i = 0; i < ms; i++) {
    jest.advanceTimersByTime(1);
    await flush();
  }
}

const mint = () => ({ method: "POST" });
const busy = (retryAfter?: string) => () => reply(503, BUSY, retryAfter);
const ok = () => reply(200, "ok");

describe("ServiceContext.invokeWithRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("busy then OK succeeds after one jittered backoff", async () => {
    const node = fakeNode([busy(), ok]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(124); // 0.5 * 250ms base: not yet
    expect(node.calls).toHaveLength(1);
    await advance(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(node.calls).toHaveLength(2);
  });

  test("reports attempts and total backoff on the returned response", async () => {
    const node = fakeNode([busy("1"), busy("2"), ok]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(3000);
    expect((await pending).retry).toEqual({ attempts: 3, backoffMs: 3000 });
    const first = await contextFor(fakeNode([ok]).fetch).invokeWithRetry("https://node/invoke", mint);
    expect(first.retry).toEqual({ attempts: 1, backoffMs: 0 });
  });

  test("honours Retry-After instead of the jittered backoff", async () => {
    const node = fakeNode([busy("2"), ok]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(1999);
    expect(node.calls).toHaveLength(1);
    await advance(1);
    expect((await pending).status).toBe(200);
    expect(node.calls[1] - node.calls[0]).toBe(2000);
  });

  test("caps Retry-After at the remaining total budget", async () => {
    const node = fakeNode([busy("60"), ok]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(12000);
    expect((await pending).status).toBe(200);
    expect(node.calls[1] - node.calls[0]).toBe(12000);
  });

  test("stops at 4 attempts and returns the final busy response", async () => {
    const node = fakeNode([busy()]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(12000);
    const response = await pending;
    expect(node.calls).toHaveLength(4);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(BUSY);
    expect(node.calls[3] - node.calls[0]).toBeLessThanOrEqual(12000);
  });

  test("Retry-After waits are cut to the remaining budget across attempts", async () => {
    const node = fakeNode([busy("5")]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(12000);
    const response = await pending;
    // 0s, 5s, 10s, then the last wait is cut to the 2s left: attempt 4 lands at the 12s budget.
    expect(node.calls.map((t) => t - node.calls[0])).toEqual([0, 5000, 10000, 12000]);
    expect(response.status).toBe(503);
  });

  test("abort mid-backoff rejects at once with the abort reason", async () => {
    const node = fakeNode([busy("10"), ok]);
    const controller = new AbortController();
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", () => ({ signal: controller.signal }));
    const outcome = pending.then(() => "resolved", (e) => e);
    await advance(100);
    const reason = new Error("caller gave up");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    await advance(20000);
    expect(node.calls).toHaveLength(1);
  });

  test("never retries OUTCOME_UNKNOWN", async () => {
    const node = fakeNode([() => reply(500, "outcome_unknown: commit may have applied"), ok]);
    const response = await contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    expect(response.status).toBe(500);
    expect(node.calls).toHaveLength(1);
  });

  test("retries REQUEST_TIMEOUT", async () => {
    const node = fakeNode([() => reply(503, "request_timeout: deadline passed"), ok]);
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
    await advance(250);
    expect((await pending).status).toBe(200);
  });

  test("does not retry a bodyless 503 or other errors", async () => {
    for (const r of [() => reply(503, ""), () => reply(500, BUSY), () => reply(404, "nope")]) {
      const node = fakeNode([r, ok]);
      await contextFor(node.fetch).invokeWithRetry("https://node/invoke", mint);
      expect(node.calls).toHaveLength(1);
    }
  });

  test("maxAttempts: 1 opts out", async () => {
    const node = fakeNode([busy(), ok]);
    const response = await contextFor(node.fetch, { maxAttempts: 1 }).invokeWithRetry("https://node/invoke", mint);
    expect(response.status).toBe(503);
    expect(node.calls).toHaveLength(1);
  });

  test("an empty retryableErrors list opts out", async () => {
    const node = fakeNode([busy(), ok]);
    const response = await contextFor(node.fetch, { retryableErrors: [] }).invokeWithRetry("https://node/invoke", mint);
    expect(response.status).toBe(503);
    expect(node.calls).toHaveLength(1);
  });

  test("calls build once per attempt and releases the discarded 503 body", async () => {
    let cancelled = 0;
    const discarded = reply(503, BUSY, "0");
    discarded.body = { cancel: async () => { cancelled++; } };
    const node = fakeNode([() => discarded, ok]);
    let builds = 0;
    const pending = contextFor(node.fetch).invokeWithRetry("https://node/invoke", () => {
      builds++;
      return { method: "POST" };
    });
    await advance(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(builds).toBe(2);
    expect(cancelled).toBe(1);
  });
});
