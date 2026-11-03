/**
 * TC-2418: a request that carries its own signal must not leave an abort
 * listener behind on the long-lived context signal, and aborting that signal
 * must still cancel a response body that is being read. The listener is
 * released when the request fails or its body is read, cancelled or errored
 * (or, for a body nobody reads, when the response is collected or sits unread
 * past the idle backstop). Node-runnable (node:test) so the Node 20/22 lanes
 * can execute it (`--expose-gc` for the collection tests); Bun runs it through
 * `bun test`.
 */
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { linkAbortSignal, releaseWithBody } from "./abortLink";
import { ServiceContext } from "./context";
import type { FetchFunction, FetchResponse, RetryPolicy } from "./types";

// This package compiles against the ES2020 lib, which predates WeakRef; every runtime the tests run on has it.
declare class WeakRef<T extends object> {
  constructor(target: T);
  deref(): T | undefined;
}

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

/** A plain object response with no body at all (what the small fakes return). */
const respond: FetchFunction = async () => reply(200);
/** A real Response with a body, like a real fetch. */
const withBody: FetchFunction = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "Fine", headers: { "x-test": "1" } });
const noBody: FetchFunction = async () => new Response(null, { status: 204 });
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
  return new Response(stream, { status: 200 });
};

function contextFor(fetch: FetchFunction, retryPolicy?: Partial<RetryPolicy>) {
  return new ServiceContext({ invoke: () => ({}), hosts: ["https://node.test"], fetch, retryPolicy });
}

const URL = "https://node.test/a";
const listeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const fresh = () => new AbortController().signal;
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
/** Let a just-started request reach the (hanging) fetch. */
const inFlight = () => new Promise<void>((resolve) => setImmediate(resolve));
/** What a per-request timeout aborts its signal with. */
const timedOut = () => new DOMException("timed out", "TimeoutError");
const asResponse = (response: FetchResponse) => response as unknown as Response;

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

type GcHost = { gc?: () => void; Bun?: { gc(force: boolean): void } };
const host = globalThis as unknown as GcHost;
/** Force a collection: `node --expose-gc`, or Bun's own. */
function collect(): void {
  if (host.gc) host.gc();
  else if (host.Bun) host.Bun.gc(true);
  else throw new Error("run with --expose-gc");
}
/**
 * Collect until `done()`; finalizers run on later turns, so give them a bounded number of turns. A `WeakRef.deref()`
 * keeps its target alive for the rest of the current job, so `done()` and `collect()` never share one.
 */
async function collectUntil(done: () => boolean): Promise<void> {
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  for (let n = 0; n < 100 && !done(); n++) {
    await turn();
    collect();
    await turn();
  }
  assert.ok(done(), "not collected within 100 turns");
}

describe("ServiceContext leaves no per-request abort listener", () => {
  test("sequential requests with no body leave no listener and print no MaxListenersExceededWarning", async () => {
    const context = contextFor(respond);
    const baseline = listeners(context.abortSignal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) await context.fetch(URL, { signal: fresh() });
    });
    assert.equal(listeners(context.abortSignal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("sequential requests whose bodies are read leave no listener and print no MaxListenersExceededWarning", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) {
        const response = await context.fetch(URL, { signal: fresh() });
        assert.deepEqual(await response.json(), { ok: true });
      }
    });
    assert.equal(listeners(context.abortSignal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("the listener stays until the body is read: it is what cancels a body in flight", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    const response = await context.fetch(URL, { signal: fresh() });
    assert.equal(listeners(context.abortSignal), baseline + 1);
    await response.text();
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("invokeWithRetry polls leave no listener and print no MaxListenersExceededWarning", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) {
        const response = await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
        await response.text();
      }
    });
    assert.equal(listeners(context.abortSignal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("a retried request leaves no listener", async () => {
    let calls = 0;
    const context = contextFor(
      async () => (++calls % 2 === 1 ? new Response(BUSY, { status: 503 }) : new Response("ok", { status: 200 })),
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    );
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < 20; i++) {
      const response = await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
      assert.equal(response.retry?.attempts, 2);
      assert.equal(await response.text(), "ok");
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("a response with no body releases at once (204)", async () => {
    const context = contextFor(noBody);
    const baseline = listeners(context.abortSignal);
    const response = await context.fetch(URL, { signal: fresh() });
    assert.equal(response.status, 204);
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("rejected requests leave no listener", async () => {
    const context = contextFor(fail);
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < REQUESTS; i++) {
      assert.match(String(await settled(context.fetch(URL, { signal: fresh() }))), /network down/);
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("timed-out requests leave no listener", async () => {
    const context = contextFor(hang);
    const baseline = listeners(context.abortSignal);
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const pending = settled(context.fetch(URL, { signal: controller.signal }));
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
      const pending = settled(context.fetch(URL, { signal: controller.signal }));
      controller.abort();
      assert.equal(((await pending) as DOMException).name, "AbortError");
    }
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("a body cancelled or errored releases", async () => {
    const context = contextFor(streaming);
    const baseline = listeners(context.abortSignal);
    const cancelled = await context.fetch(URL, { signal: fresh() });
    await asResponse(cancelled).body!.cancel();
    assert.equal(listeners(context.abortSignal), baseline);
    const controller = new AbortController();
    const errored = await context.fetch(URL, { signal: controller.signal });
    const read = settled(errored.text());
    await inFlight();
    controller.abort();
    assert.equal(((await read) as DOMException).name, "AbortError");
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("an unread body is released once the response is garbage collected", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    await (async () => {
      await context.fetch(URL, { signal: fresh() }); // dropped without reading
    })();
    assert.equal(listeners(context.abortSignal), baseline + 1);
    await collectUntil(() => listeners(context.abortSignal) === baseline);
  });

  test("bodies read to the end and dropped are not retained by the release machinery", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    const readThenWatch = async () => {
      const response = await context.fetch(URL, { signal: fresh() });
      await response.text();
      return new WeakRef(response);
    };
    const watched: WeakRef<object>[] = [];
    for (let i = 0; i < 20; i++) watched.push(await readThenWatch());
    // The engine may keep the newest few alive through stale registers; the rest must go.
    await collectUntil(() => watched.filter((ref) => ref.deref() === undefined).length >= 15);
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("1000 requests with bodies read keep a flat heap", async () => {
    const context = contextFor(withBody);
    const run = async (count: number) => {
      for (let i = 0; i < count; i++) await (await context.fetch(URL, { signal: fresh() })).text();
    };
    // Finalizers run on later turns, so settle over several collections before each reading.
    const settle = async () => {
      for (let turn = 0; turn < 10; turn++) {
        collect();
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await run(500); // warm up
    await settle();
    const before = process.memoryUsage().heapUsed;
    await run(3000);
    await settle();
    const perRequest = (process.memoryUsage().heapUsed - before) / 3000;
    // A listener that is never removed retains about 1.2 KB per request.
    assert.ok(perRequest < 300, `${perRequest.toFixed(0)} B retained per request`);
  });
});

describe("ServiceContext abort behaviour", () => {
  test("aborting the context aborts an in-flight request with the context's reason", async () => {
    const context = contextFor(hang);
    const pending = settled(context.fetch(URL, { signal: fresh() }));
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
    const pending = settled(context.fetch(URL, { signal: controller.signal }));
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
    const timed = settled(context.fetch(URL, { signal: own.signal }));
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
    await context.fetch(URL, { signal: controller.signal });
    assert.equal(received!.aborted, true);
    assert.equal(received!.reason, reason);
  });

  test("aborting the context after the headers cancels the body read", async () => {
    const context = contextFor(streaming);
    const baseline = listeners(context.abortSignal);
    const response = await context.fetch(URL, { signal: fresh() });
    const read = settled(response.text());
    await inFlight();
    context.abort();
    assert.equal(((await read) as DOMException).name, "AbortError");
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("aborting the context after the headers cancels an invokeWithRetry body read", async () => {
    const context = contextFor(streaming);
    const response = await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
    const read = settled(response.text());
    await inFlight();
    context.abort();
    assert.equal(((await read) as DOMException).name, "AbortError");
  });

  test("aborting the request's own signal after the headers cancels the body read", async () => {
    const context = contextFor(streaming);
    const controller = new AbortController();
    const response = await context.fetch(URL, { signal: controller.signal });
    const read = settled(response.text());
    await inFlight();
    controller.abort();
    assert.equal(((await read) as DOMException).name, "AbortError");
  });
});

describe("ServiceContext keeps the response usable", () => {
  test("status, statusText, ok, headers and every body reader behave like the original", async () => {
    const context = contextFor(withBody);
    const response = await context.fetch(URL, { signal: fresh() });
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    assert.equal(response.statusText, "Fine");
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("x-test"), "1");
    assert.deepEqual(await response.clone().json(), { ok: true });
    assert.equal(await response.clone().text(), '{"ok":true}');
    assert.equal(new TextDecoder().decode(await response.clone().arrayBuffer()), '{"ok":true}');
    assert.equal(await (await response.clone().blob()).text(), '{"ok":true}');
    assert.equal(response.bodyUsed, false);
    await response.text();
    assert.equal(response.bodyUsed, true);
  });

  test("a reader can stream the body and release at the end", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    const response = await context.fetch(URL, { signal: fresh() });
    const reader = asResponse(response).body!.getReader();
    let text = "";
    for (let read = await reader.read(); !read.done; read = await reader.read()) text += new TextDecoder().decode(read.value);
    assert.equal(text, '{"ok":true}');
    assert.equal(listeners(context.abortSignal), baseline);
  });

  test("a clone read to the end releases while the original stays readable", async () => {
    const context = contextFor(withBody);
    const baseline = listeners(context.abortSignal);
    const response = await context.fetch(URL, { signal: fresh() });
    await asResponse(response).clone().text();
    assert.equal(listeners(context.abortSignal), baseline);
    assert.equal(await response.text(), '{"ok":true}');
  });

  test("invokeWithRetry still sets `retry` on the response it returns", async () => {
    const context = contextFor(withBody);
    const response = await context.invokeWithRetry("https://node.test/invoke", () => ({ method: "POST", signal: fresh() }));
    assert.deepEqual(response.retry, { attempts: 1, backoffMs: 0 });
  });
});

/** A source whose body the test can observe being pulled and cancelled. */
function observedBody(chunks: string[]) {
  const seen = { pulls: 0, cancelledWith: undefined as unknown };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls++;
        if (next < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[next++]));
        else controller.close();
      },
      cancel(reason) {
        seen.cancelledWith = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { seen, response: new Response(stream, { status: 200, statusText: "OK", headers: { "x-test": "1" } }) };
}

describe("releaseWithBody", () => {
  test("releases once on every settle path, however many follow", async () => {
    for (const settle of ["end", "cancel", "error"] as const) {
      let released = 0;
      const source =
        settle === "error"
          ? new Response(new ReadableStream({ start: (controller) => controller.error(new Error("boom")) }))
          : observedBody(["a", "b"]).response;
      const held = releaseWithBody(source, () => void released++);
      assert.equal(released, 0);
      if (settle === "end") await held.text();
      else if (settle === "cancel") await held.body!.cancel("why");
      else await assert.rejects(held.text(), /boom/);
      assert.equal(released, 1, settle);
      await held.body?.cancel().catch(() => undefined);
      assert.equal(released, 1, `${settle} then cancel`);
    }
  });

  test("passes a cancel through to the source with its reason and does not read ahead", async () => {
    const { seen, response } = observedBody(["a", "b", "c"]);
    const held = releaseWithBody(response, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.pulls, 0, "nothing is read before the caller reads");
    const reader = held.body!.getReader();
    await reader.read();
    assert.equal(seen.pulls, 1, "one read pulls one chunk");
    await reader.cancel("why");
    assert.equal(seen.cancelledWith, "why");
  });

  test("keeps the status, status text and headers", () => {
    const held = releaseWithBody(observedBody(["a"]).response, () => undefined);
    assert.equal(held.status, 200);
    assert.equal(held.statusText, "OK");
    assert.equal(held.headers.get("x-test"), "1");
  });

  test("releases at once for a null body and for an object that is not a Response", () => {
    let released = 0;
    const empty = new Response(null, { status: 204 });
    assert.equal(releaseWithBody(empty, () => void released++), empty);
    const plain = reply(200);
    assert.equal(releaseWithBody(plain, () => void released++), plain);
    assert.equal(released, 2);
  });

  // Real timer on purpose: the backstop is a timer, and a fake clock would not exercise its unref/clear handling.
  // The backstop's timer is unref'd, so the test holds the event loop open itself while it waits.
  test("releases a body nobody reads after the idle backstop, once, and the body stays readable", async () => {
    const keepAlive = setTimeout(() => undefined, 10_000);
    try {
      let released = 0;
      let onRelease!: () => void;
      const done = new Promise<void>((resolve) => (onRelease = resolve));
      // Held here, so only the timer (not a collection) can release it.
      const held = releaseWithBody(observedBody(["a"]).response, () => { released++; onRelease(); }, 10);
      await done;
      assert.equal(released, 1);
      assert.equal(await held.text(), "a");
      assert.equal(released, 1, "reading to the end after the backstop does not release again");
    } finally {
      clearTimeout(keepAlive);
    }
  });

  // Real timer on purpose, see above. A body that is being read has no backstop: a stalled stream stays linked.
  test("does not time out a body whose read has started", async () => {
    let released = 0;
    const stalled = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), { status: 200 });
    const held = releaseWithBody(stalled, () => void released++, 5);
    const read = held.body!.getReader().read();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(released, 0);
    void read;
  });

  test("a response dropped after its read started is released when collected", async () => {
    let released = 0;
    await (async () => {
      const stalled = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), { status: 200 });
      const held = releaseWithBody(stalled, () => void released++);
      void held.body!.getReader().read();
    })();
    await collectUntil(() => released === 1);
  });
});

describe("linkAbortSignal", () => {
  test("combines the signals and release removes only the long-lived listener, idempotently", () => {
    const own = new AbortController();
    const mine = new AbortController();
    const link = linkAbortSignal(own.signal, mine.signal, true);
    assert.equal(listeners(own.signal), 1);
    link.release();
    link.release();
    assert.equal(listeners(own.signal), 0);
    mine.abort(new Error("x"));
    assert.equal(link.signal.aborted, true);
  });

  test("returns the long-lived signal itself when the request has none", () => {
    const own = new AbortController();
    assert.equal(linkAbortSignal(own.signal, undefined, true).signal, own.signal);
  });
});
