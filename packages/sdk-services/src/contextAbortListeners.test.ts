/**
 * TC-2418: a request that carries its own signal must not leave an abort
 * listener behind on the long-lived context signal. Node-runnable (node:test)
 * so the Node 20 lane can execute it; Bun runs it through `bun test`.
 */
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ServiceContext } from "./context";
import type { FetchFunction, FetchResponse, RetryPolicy } from "./types";

const REQUESTS = 1000;
const BUSY = "sql_busy: begin: database is locked";

function reply(status: number, body = ""): FetchResponse {
  const response: FetchResponse = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob([]),
    clone: () => response,
  };
  return response;
}

const respond: FetchFunction = async () => reply(200);
const fail: FetchFunction = async () => {
  throw new Error("network down");
};
/** Never answers; rejects with the request signal's reason when it aborts. */
const hang: FetchFunction = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

function contextFor(fetch: FetchFunction, retryPolicy?: Partial<RetryPolicy>) {
  return new ServiceContext({ invoke: () => ({}), hosts: ["https://node.test"], fetch, retryPolicy });
}

const listeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const fresh = () => new AbortController().signal;
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
/** Let a just-started request reach the (hanging) fetch. */
const inFlight = () => new Promise<void>((resolve) => setImmediate(resolve));
/** What a per-request timeout aborts its signal with. */
const timedOut = () => new DOMException("timed out", "TimeoutError");

/** Run `work` and return the warnings Node emitted while it ran. */
async function warningsDuring(work: () => Promise<void>): Promise<Error[]> {
  const seen: Error[] = [];
  const onWarning = (warning: Error) => void seen.push(warning);
  process.on("warning", onWarning);
  try {
    await work();
    await new Promise((resolve) => setImmediate(resolve)); // warnings are delivered on a later tick
  } finally {
    process.off("warning", onWarning);
  }
  return seen;
}

describe("ServiceContext releases its per-request abort listener", () => {
  test("sequential requests on one context leave no listener and print no MaxListenersExceededWarning", async () => {
    const context = contextFor(respond);
    const baseline = listeners(context.abortSignal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) await context.fetch("https://node.test/a", { signal: fresh() });
    });
    assert.equal(listeners(context.abortSignal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("invokeWithRetry polls leave no listener and print no MaxListenersExceededWarning", async () => {
    const context = contextFor(respond);
    const baseline = listeners(context.abortSignal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) {
        await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
      }
    });
    assert.equal(listeners(context.abortSignal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("a retried request leaves no listener", async () => {
    let calls = 0;
    const context = contextFor(
      async () => (++calls % 2 === 1 ? reply(503, BUSY) : reply(200)),
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    );
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < 20; i++) {
      const response = await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
      assert.equal(response.retry?.attempts, 2);
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("rejected requests leave no listener", async () => {
    const context = contextFor(fail);
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < REQUESTS; i++) {
      assert.match(String(await settled(context.fetch("https://node.test/a", { signal: fresh() }))), /network down/);
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("timed-out requests leave no listener", async () => {
    const context = contextFor(hang);
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const pending = settled(context.fetch("https://node.test/a", { signal: controller.signal }));
      controller.abort(timedOut());
      assert.equal(((await pending) as DOMException).name, "TimeoutError");
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("aborted requests leave no listener", async () => {
    const context = contextFor(hang);
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const pending = settled(context.fetch("https://node.test/a", { signal: controller.signal }));
      controller.abort();
      assert.equal(((await pending) as DOMException).name, "AbortError");
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });
});

describe("ServiceContext abort behaviour", () => {
  test("aborting the context aborts an in-flight request with the context's reason", async () => {
    const context = contextFor(hang);
    const pending = settled(context.fetch("https://node.test/a", { signal: fresh() }));
    await inFlight();
    context.abort();
    assert.equal(((await pending) as DOMException).name, "AbortError");
  });

  test("aborting the context aborts an in-flight invokeWithRetry request", async () => {
    const context = contextFor(hang);
    const pending = settled(
      context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() })),
    );
    await inFlight();
    context.abort();
    assert.equal(((await pending) as DOMException).name, "AbortError");
  });

  test("a request's own timeout aborts only that request", async () => {
    const seen: AbortSignal[] = [];
    const fetch: FetchFunction = (url, init) => {
      seen.push(init!.signal!);
      return hang(url, init);
    };
    const context = contextFor(fetch);
    const own = new AbortController();
    const timed = settled(context.fetch("https://node.test/a", { signal: own.signal }));
    const other = new AbortController();
    const survivor = settled(context.fetch("https://node.test/b", { signal: other.signal }));
    own.abort(timedOut());
    assert.equal(((await timed) as DOMException).name, "TimeoutError");
    assert.equal(seen[0].aborted, true);
    assert.equal(seen[1].aborted, false);
    assert.equal(context.abortSignal.aborted, false);
    other.abort();
    await survivor;
  });

  test("an already-aborted request signal reaches fetch aborted, with its reason", async () => {
    let received: AbortSignal | undefined;
    const context = contextFor(async (_url, init) => {
      received = init!.signal!;
      return reply(200);
    });
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    await context.fetch("https://node.test/a", { signal: controller.signal });
    assert.equal(received!.aborted, true);
    assert.equal(received!.reason, reason);
  });
});
