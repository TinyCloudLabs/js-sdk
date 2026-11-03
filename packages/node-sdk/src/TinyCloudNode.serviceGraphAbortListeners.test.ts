/**
 * TC-2418: the node's service graph combines each request's signal with its
 * own lifetime signal. A request must not leave an abort listener behind on
 * that long-lived signal, and retiring the graph must still cancel a response
 * body that is being read. The listener is released when the request fails or
 * its body is read, cancelled or errored (or, for a body nobody reads, when
 * the response is collected or sits unread past the idle backstop).
 * Node-runnable (node:test) so the Node 20/22 lanes can execute it
 * (`--expose-gc` for the collection test); Bun runs it through `bun test`.
 */
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { FetchFunction, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const REQUESTS = 1000;
const URL = "https://node.test/a";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type TestFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const withBody: TestFetch = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "Fine", headers: { "x-test": "1" } });
const noBody: TestFetch = async () => new Response(null, { status: 204 });
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

type GcHost = { gc?: () => void; Bun?: { gc(force: boolean): void } };
const host = globalThis as unknown as GcHost;
/** Force a collection: `node --expose-gc`, or Bun's own. */
function collect(): void {
  if (host.gc) host.gc();
  else if (host.Bun) host.Bun.gc(true);
  else throw new Error("run with --expose-gc");
}
/** Collect until `done()`; finalizers run on a later turn, so give them a bounded number of turns. */
async function collectUntil(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !done(); turn++) {
    collect();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done(), "not collected within 100 turns");
}

describe("ServiceGraphLifetime leaves no per-request abort listener", () => {
  test("sequential requests whose bodies are read leave no listener and print no MaxListenersExceededWarning", async () => {
    const graph = graphFor(withBody);
    const baseline = listeners(graph.signal);
    const warnings = await warningsDuring(async () => {
      for (let i = 0; i < REQUESTS; i++) {
        const response = await graph.fetch(URL, { signal: fresh() });
        assert.deepEqual(await response.json(), { ok: true });
      }
    });
    assert.equal(listeners(graph.signal), baseline);
    assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning"), []);
  });

  test("the listener stays until the body is read: it is what cancels a body in flight", async () => {
    const graph = graphFor(withBody);
    const baseline = listeners(graph.signal);
    const response = await graph.fetch(URL, { signal: fresh() });
    assert.equal(listeners(graph.signal), baseline + 1);
    await response.text();
    assert.equal(listeners(graph.signal), baseline);
  });

  test("a response with no body releases at once (204)", async () => {
    const graph = graphFor(noBody);
    const baseline = listeners(graph.signal);
    assert.equal((await graph.fetch(URL, { signal: fresh() })).status, 204);
    assert.equal(listeners(graph.signal), baseline);
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

  test("a fetch that throws synchronously leaves no listener and still throws synchronously", () => {
    const graph = graphFor(() => {
      throw new Error("no network stack");
    });
    const baseline = listeners(graph.signal);
    assert.throws(() => graph.fetch(URL, { signal: fresh() }), /no network stack/);
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

  test("a body cancelled or errored releases", async () => {
    const graph = graphFor(streaming);
    const baseline = listeners(graph.signal);
    const cancelled = await graph.fetch(URL, { signal: fresh() });
    await (cancelled as unknown as Response).body!.cancel();
    assert.equal(listeners(graph.signal), baseline);
    const controller = new AbortController();
    const errored = await graph.fetch(URL, { signal: controller.signal });
    const read = settled(errored.text());
    await inFlight();
    controller.abort();
    assert.equal(((await read) as DOMException).name, "AbortError");
    assert.equal(listeners(graph.signal), baseline);
  });

  test("an unread body is released once the response is garbage collected", async () => {
    const graph = graphFor(withBody);
    const baseline = listeners(graph.signal);
    await (async () => {
      await graph.fetch(URL, { signal: fresh() }); // dropped without reading
    })();
    assert.equal(listeners(graph.signal), baseline + 1);
    await collectUntil(() => listeners(graph.signal) === baseline);
  });
});

describe("ServiceGraphLifetime abort behaviour", () => {
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

  test("a request's own abort reaches fetch as a bare AbortError, not its own reason", async () => {
    const graph = graphFor(hang);
    const controller = new AbortController();
    const reason = new DOMException("timed out", "TimeoutError");
    const pending = settled(graph.fetch(URL, { signal: controller.signal }));
    await inFlight();
    controller.abort(reason);
    const error = (await pending) as DOMException;
    assert.equal(error.name, "AbortError");
    assert.notEqual(error, reason);
  });

  test("retiring the graph after the headers cancels the body read", async () => {
    const graph = graphFor(streaming);
    const baseline = listeners(graph.signal);
    const response = await graph.fetch(URL, { signal: fresh() });
    const read = settled(response.text());
    await inFlight();
    graph.retire();
    assert.equal(((await read) as DOMException).name, "AbortError");
    assert.equal(listeners(graph.signal), baseline);
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

describe("ServiceGraphLifetime keeps the response usable", () => {
  test("status, statusText, ok, headers and every body reader behave like the original", async () => {
    const graph = graphFor(withBody);
    const response = await graph.fetch(URL, { signal: fresh() });
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    assert.equal(response.statusText, "Fine");
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("x-test"), "1");
    assert.deepEqual(await response.clone().json(), { ok: true });
    assert.equal(await response.clone().text(), '{"ok":true}');
    assert.equal(new TextDecoder().decode(await response.clone().arrayBuffer()), '{"ok":true}');
    assert.equal(await (await response.clone().blob()).text(), '{"ok":true}');
    assert.equal(await response.text(), '{"ok":true}');
  });
});
