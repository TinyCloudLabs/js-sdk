/**
 * TC-2418: the node's service graph combines each request's signal with its
 * own lifetime signal. Where `AbortSignal.any` exists it does that without
 * leaving a listener on the long-lived signal; where it is missing the
 * combiner is exactly what it was before (a listener that is never removed).
 * Every behaviour test runs on both branches (the test removes
 * `AbortSignal.any` for the fallback). Node-runnable (node:test) so the Node
 * 20 lane can execute it; Bun runs it through `bun test`.
 */
import { getEventListeners, setMaxListeners } from "node:events";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { FetchFunction, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const REQUESTS = 1000;
const URL = "https://node.test/a";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type TestFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const ok: TestFetch = async () => new Response(null, { status: 200 });
/** Never answers; rejects with the request signal's reason when it aborts. */
const hang: TestFetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const { signal } = init;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
/** Answers at once with a body that never ends and errors when the request signal aborts, like a real fetch body. */
const streaming: TestFetch = async (_url, init) => {
  const { signal } = init;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => controller.error(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  });
  return new Response(stream, { status: 200 });
};

/** The graph members these tests drive; it is private to the node. */
interface ServiceGraph {
  fetch: FetchFunction;
  signal: AbortSignal;
  retire(): void;
}

/** A node whose service graph fetches through `fetch`, resolved at request time. */
function graphFor(fetch: TestFetch): ServiceGraph {
  const wasmBindings = {
    createSessionManager: () => ({
      createSessionKey: (id: string) => id,
      replaceSessionKey: (_jwk: object, keyId: string) => keyId,
      renameSessionKeyId: () => {},
      getDID: (keyId: string) => `did:key:${keyId}`,
      jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test", d: "test" }),
    }),
  } as unknown as IWasmBindings;
  const node = new TinyCloudNode({
    host: "https://node.test",
    signer: { getAddress: async () => "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", getChainId: async () => 1, signMessage: async () => "0xsig" },
    wasmBindings,
  });
  globalThis.fetch = fetch as typeof globalThis.fetch;
  // The graph is private; read it through a structural view of the node.
  const internals = node as unknown as { _serviceGraph: ServiceGraph };
  return internals._serviceGraph;
}

const listeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const fresh = () => new AbortController().signal;
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
/** Let a just-started request reach the (hanging) fetch. */
const inFlight = () => new Promise<void>((resolve) => setImmediate(resolve));

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

describe("ServiceGraphLifetime [any] leaves no per-request abort listener", () => {
  const { anyCalls } = useBranch("any");

  test("uses AbortSignal.any", async () => {
    const graph = graphFor(ok);
    await graph.fetch(URL, { signal: fresh() });
    assert.equal(anyCalls(), 1);
  });

  test("sequential requests leave no listener and print no MaxListenersExceededWarning", async () => {
    const graph = graphFor(ok);
    const baseline = listeners(graph.signal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) await graph.fetch(URL, { signal: fresh() });
    });
    assert.equal(listeners(graph.signal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("rejected requests leave no listener", async () => {
    const graph = graphFor(async () => {
      throw new Error("network down");
    });
    const baseline = listeners(graph.signal);
    for (let i = 0; i < REQUESTS; i++) {
      assert.match(String(await settled(graph.fetch(URL, { signal: fresh() }))), /network down/);
    }
    assert.equal(listeners(graph.signal), baseline);
  });

  test("timed-out requests leave no listener", async () => {
    const graph = graphFor(hang);
    const baseline = listeners(graph.signal);
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const pending = settled(graph.fetch(URL, { signal: controller.signal }));
      controller.abort(new DOMException("timed out", "TimeoutError"));
      assert.ok((await pending) instanceof DOMException);
    }
    assert.equal(listeners(graph.signal), baseline);
  });

  test("aborted requests leave no listener", async () => {
    const graph = graphFor(hang);
    const baseline = listeners(graph.signal);
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const pending = settled(graph.fetch(URL, { signal: controller.signal }));
      controller.abort();
      assert.equal(((await pending) as DOMException).name, "AbortError");
    }
    assert.equal(listeners(graph.signal), baseline);
  });
});

// Without AbortSignal.any (older browsers) the combiner is what it was before this change. These pin that, so
// nobody fixes it halfway: the listener stays until the graph retires, and the link is never cut.
describe("ServiceGraphLifetime [listeners] is unchanged from before", () => {
  const { anyCalls } = useBranch("listeners");

  test("does not use AbortSignal.any", async () => {
    const graph = graphFor(ok);
    await graph.fetch(URL, { signal: fresh() });
    assert.equal(anyCalls(), 0);
  });

  test("each request that carries its own signal leaves a listener until the graph retires", async () => {
    const graph = graphFor(ok);
    setMaxListeners(0, graph.signal); // the pile-up is the point; keep Node 20's warning out of the test output
    for (let i = 0; i < 50; i++) await graph.fetch(URL, { signal: fresh() });
    assert.equal(listeners(graph.signal), 50);
    graph.retire();
    assert.equal(listeners(graph.signal), 0);
  });

  test("a rejected request leaves its listener too", async () => {
    const graph = graphFor(async () => {
      throw new Error("network down");
    });
    await settled(graph.fetch(URL, { signal: fresh() }));
    assert.equal(listeners(graph.signal), 1);
  });
});

for (const branch of ["any", "listeners"] as const) {
  describe(`ServiceGraphLifetime [${branch}] abort behaviour`, () => {
    useBranch(branch);

    test("retiring the graph aborts an in-flight request", async () => {
      const graph = graphFor(hang);
      const pending = settled(graph.fetch(URL, { signal: fresh() }));
      await inFlight();
      graph.retire();
      assert.equal(((await pending) as DOMException).name, "AbortError");
    });

    test("a request's own timeout aborts only that request", async () => {
      const seen: AbortSignal[] = [];
      const graph = graphFor((url, init) => {
        seen.push(init.signal);
        return hang(url, init);
      });
      const own = new AbortController();
      const timed = settled(graph.fetch(URL, { signal: own.signal }));
      const other = new AbortController();
      const survivor = settled(graph.fetch("https://node.test/b", { signal: other.signal }));
      own.abort(new DOMException("timed out", "TimeoutError"));
      await timed;
      assert.equal(seen[0].aborted, true);
      assert.equal(seen[1].aborted, false);
      assert.equal(graph.signal.aborted, false);
      other.abort();
      await survivor;
    });

    test("an already-aborted request signal reaches fetch aborted", async () => {
      let received: AbortSignal | undefined;
      const graph = graphFor(async (_url, init) => {
        received = init.signal;
        return new Response(null, { status: 200 });
      });
      const controller = new AbortController();
      controller.abort();
      await graph.fetch(URL, { signal: controller.signal });
      assert.equal(received!.aborted, true);
    });

    // The one deliberate difference between the branches: the listener fallback aborts without a
    // reason (a fresh AbortError), as it always did, while AbortSignal.any carries the source's own reason through.
    test("a request's own abort reaches fetch with the reason this branch carries", async () => {
      const graph = graphFor(hang);
      const controller = new AbortController();
      const reason = new DOMException("timed out", "TimeoutError");
      const pending = settled(graph.fetch(URL, { signal: controller.signal }));
      await inFlight();
      controller.abort(reason);
      const error = (await pending) as DOMException;
      if (branch === "any") assert.equal(error, reason);
      else {
        assert.equal(error.name, "AbortError");
        assert.notEqual(error, reason);
      }
    });

    test("retiring the graph after the headers cancels the body read", async () => {
      const graph = graphFor(streaming);
      const response = await graph.fetch(URL, { signal: fresh() });
      const read = settled(response.text());
      await inFlight();
      graph.retire();
      assert.equal(((await read) as DOMException).name, "AbortError");
    });

    test("aborting the request's own signal after the headers cancels the body read", async () => {
      const graph = graphFor(streaming);
      const controller = new AbortController();
      const response = await graph.fetch(URL, { signal: controller.signal });
      const read = settled(response.text());
      await inFlight();
      controller.abort();
      assert.equal(((await read) as DOMException).name, "AbortError");
    });
  });
}
