/**
 * TC-2418: a request that carries its own signal must not leave an abort
 * listener behind on the long-lived context signal. Every test runs on both
 * branches of the signal combiner: native `AbortSignal.any`, and the listener
 * fallback used where it is missing (the test removes it). Node-runnable
 * (node:test) so the Node 20 lane can execute it; Bun runs it through `bun test`.
 */
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
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
/** Answers at once with a body that never ends and errors when the request signal aborts, like a real fetch body. */
const streaming: FetchFunction = async (_url, init) => {
  const signal = init!.signal!;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => controller.error(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  });
  return Object.assign(reply(200), {
    text: async () => {
      await stream.getReader().read();
      return "";
    },
  });
};

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

type SignalStatics = { any?: (signals: AbortSignal[]) => AbortSignal };
const statics = AbortSignal as unknown as SignalStatics;
const nativeAny = statics.any;

/** Install one branch of the combiner for the tests in the enclosing `describe`; returns how often `AbortSignal.any` ran. */
function useBranch(branch: "any" | "listeners"): { anyCalls: () => number } {
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    statics.any =
      branch === "listeners"
        ? undefined
        : (signals) => {
            calls++;
            return nativeAny!.call(AbortSignal, signals);
          };
  });
  afterEach(() => {
    statics.any = nativeAny;
  });
  return { anyCalls: () => calls };
}

for (const branch of ["any", "listeners"] as const) {
  describe(`ServiceContext [${branch}] leaves no per-request abort listener`, () => {
    const { anyCalls } = useBranch(branch);

    test("uses the branch under test", async () => {
      const context = contextFor(respond);
      await context.fetch("https://node.test/a", { signal: fresh() });
      assert.equal(anyCalls(), branch === "any" ? 1 : 0);
    });

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

  describe(`ServiceContext [${branch}] abort behaviour`, () => {
    useBranch(branch);

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

    test("a request's own abort reaches fetch with its own reason", async () => {
      const context = contextFor(hang);
      const controller = new AbortController();
      const reason = new Error("stop");
      const pending = settled(context.fetch("https://node.test/a", { signal: controller.signal }));
      await inFlight();
      controller.abort(reason);
      assert.equal(await pending, reason);
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

    test("aborting the request's own signal after the headers cancels the body read", async () => {
      const context = contextFor(streaming);
      const controller = new AbortController();
      const response = await context.fetch("https://node.test/a", { signal: controller.signal });
      const read = settled(response.text());
      await inFlight();
      controller.abort();
      assert.equal(((await read) as DOMException).name, "AbortError");
    });

    // A release at settle time would cut this link on the listener fallback (a known gap on runtimes
    // without AbortSignal.any: Chrome < 116, Safari < 17.4, Firefox < 124); the contract holds on the native branch.
    if (branch === "any") {
      test("aborting the context after the headers cancels the body read", async () => {
        const context = contextFor(streaming);
        const response = await context.fetch("https://node.test/a", { signal: fresh() });
        const read = settled(response.text());
        await inFlight();
        context.abort();
        assert.equal(((await read) as DOMException).name, "AbortError");
      });

      test("aborting the context after the headers cancels an invokeWithRetry body read", async () => {
        const context = contextFor(streaming);
        const response = await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
        const read = settled(response.text());
        await inFlight();
        context.abort();
        assert.equal(((await read) as DOMException).name, "AbortError");
      });
    }
  });
}
