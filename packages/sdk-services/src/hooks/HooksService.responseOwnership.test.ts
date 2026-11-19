import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { HooksService } from "./HooksService";
import type { ServiceSession } from "../types";
const session: ServiceSession = { delegationHeader: {}, delegationCid: "A", verificationMethod: "A", jwk: {}, spaceId: "space-A" };
const gate = () => { let resolve!: () => void; return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() }; };
function body(onCancel: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) { for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i])); controller.close(); },
    cancel: onCancel,
  });
}

test("a refused hook stream releases its body before backoff and sibling background work", async () => {
  const host = "https://hook-refusal-ownership.invalid"; const backoff = gate(); const wait = gate(); let cancelled = 0;
  const owner = new ServiceContext({ hosts: [host], session, priority: "background", invoke: () => ({}),
    fetch: async (url) => url.includes("/tickets") ? Response.json({ ticket: "fixture-ticket" }) : new Response(body(() => { cancelled++; }), { status: 403 }),
  });
  const sibling = new ServiceContext({ hosts: [host], priority: "background", invoke: () => ({}), fetch: async () => new Response("next") });
  const service = new HooksService({ streamRetry: { delay: () => 10_000, wait: async () => { backoff.resolve(); await wait.promise; } } });
  service.initialize(owner); const abort = new AbortController();
  const iterator = service.subscribe([{ space: session.spaceId, service: "kv", pathPrefix: "", abilities: ["tinycloud.kv/put"] }], { signal: abort.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  try {
    await backoff.promise; expect(cancelled).toBe(1);
    expect(await (await sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1500) })).text()).toBe("next");
  } finally { abort.abort(); service.onSignOut(); wait.resolve(); owner.retire(); sibling.retire(); await pending; await iterator.return?.(); }
});

for (const stage of ["tickets", "events"] as const) {
  test(`a late acquired ${stage} response is released after subscription retirement`, async () => {
    const host = `https://hook-late-${stage}.invalid`; const entered = gate(); const release = gate(); let cancelled = 0;
    const owner = new ServiceContext({ hosts: [host], session, priority: "background", invoke: () => ({}), fetch: async (url) => {
      if (stage === "events" && url.includes("/tickets")) return Response.json({ ticket: "fixture-ticket" });
      entered.resolve(); await release.promise;
      return new Response(body(() => { cancelled++; }), { status: 403 });
    } });
    const sibling = new ServiceContext({ hosts: [host], priority: "background", invoke: () => ({}), fetch: async () => new Response("next") });
    const service = new HooksService(); service.initialize(owner); const abort = new AbortController();
    const iterator = service.subscribe([{ space: session.spaceId, service: "kv", pathPrefix: "", abilities: ["tinycloud.kv/put"] }], { signal: abort.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    try {
      await entered.promise; abort.abort(); await pending; release.resolve();
      expect(await (await sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1500) })).text()).toBe("next");
      expect(cancelled).toBe(1);
    } finally { abort.abort(); release.resolve(); service.onSignOut(); owner.retire(); sibling.retire(); await iterator.return?.(); }
  });
}
