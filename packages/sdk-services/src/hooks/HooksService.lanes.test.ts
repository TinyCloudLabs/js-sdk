import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { HooksService } from "./HooksService";
import type { ServiceSession } from "../types";

const session: ServiceSession = { delegationHeader: {}, delegationCid: "A", verificationMethod: "A", jwk: {}, spaceId: "space-A" };

test("an open foreground hook stream does not hold the host's lanes", async () => {
  const host = "https://hook-stream-lanes.invalid";
  let opened!: () => void;
  const streaming = new Promise<void>((resolve) => { opened = resolve; });
  const owner = new ServiceContext({ hosts: [host], session, invoke: () => ({}), fetch: async (url) => {
    if (url.includes("/tickets")) return Response.json({ ticket: "fixture-ticket" });
    opened();
    // An event stream: one ready marker, then the connection stays open.
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"type":"ready"}\n\n')); },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const sibling = new ServiceContext({ hosts: [host], priority: "background", invoke: () => ({}), fetch: async () => new Response("synced") });
  const service = new HooksService();
  service.initialize(owner);
  const abort = new AbortController();
  const iterator = service.subscribe([{ space: session.spaceId, service: "kv", pathPrefix: "", abilities: ["tinycloud.kv/put"] }], { signal: abort.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  try {
    await streaming;
    // Lane waiting is bounded at 5 s; this deadline fails if the stream occupies the foreground lane.
    const response = await sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1_500) });
    expect(await response.text()).toBe("synced");
  } finally {
    abort.abort();
    service.onSignOut();
    owner.retire();
    sibling.retire();
    await pending.catch(() => undefined);
    await iterator.return?.();
  }
});
