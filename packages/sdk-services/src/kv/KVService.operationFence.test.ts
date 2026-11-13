import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { KVService } from "./KVService";
import { discardResponse } from "../responseBody";
import type { ServiceSession } from "../types";

const session = (name: string): ServiceSession => ({
  delegationHeader: { Authorization: name }, delegationCid: name,
  spaceId: `tinycloud:pkh:eip155:1:0x1:${name}`, verificationMethod: name, jwk: {},
});
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
};

test.each(["get", "put", "batchPut", "list", "delete"] as const)(
  "%s cannot acquire a replacement identity after replica readiness", async (method) => {
    const signed: string[] = [];
    const context = new ServiceContext({
      hosts: [`https://${method}-readiness.invalid`], session: session("A"),
      invoke: (owner) => { signed.push(owner.delegationCid); return {}; },
      invokeAny: (owner) => { signed.push(owner.delegationCid); return {}; },
      fetch: async () => new Response("[]"),
    });
    const kv = new KVService(); kv.initialize(context);
    const ready = deferred(); kv.setReadThroughReady(ready.promise);
    const pending = method === "get" ? kv.get("note")
      : method === "put" ? kv.put("note", "value")
      : method === "batchPut" ? kv.batchPut([{ key: "note", value: "value" }])
      : method === "list" ? kv.list() : kv.delete("note");
    context.setSession(session("B")); ready.resolve();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ABORTED");
    expect(signed).toEqual([]);
    context.retire();
  }
);

test.each(["put", "delete", "head"] as const)(
  "%s releases its discarded body before sibling background work", async (method) => {
    const host = `https://${method}-discard.invalid`;
    let cancelled = false;
    const writer = new ServiceContext({
      hosts: [host], session: session("A"), invoke: () => ({}),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i])); controller.close(); },
        cancel() { cancelled = true; },
      })),
    });
    const sibling = new ServiceContext({ hosts: [host], priority: "background", invoke: () => ({}), fetch: async () => new Response("next") });
    const kv = new KVService(); kv.initialize(writer);
    try {
      const result = method === "put" ? await kv.put("note", "value") : method === "delete" ? await kv.delete("note") : await kv.head("note");
      expect(result.ok).toBe(true);
      expect(cancelled).toBe(true);
      expect(await (await sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1500) })).text()).toBe("next");
    } finally { writer.retire(); sibling.retire(); }
  }
);

test("discard cleanup supports structural bodies and preserves acknowledged success on cleanup failure", async () => {
  let consumed = 0;
  const response = new Response("unused");
  await discardResponse({ ...response, body: undefined, text: async () => { consumed++; return "unused"; } } as never);
  await discardResponse({ ...response, body: { cancel: async () => { throw new Error("closed"); } } } as never);
  expect(consumed).toBe(1);
});

test("a deferred read-through write cannot recapture the replacement session", async () => {
  const ready = deferred(); const entered = deferred(); const signed: string[] = [];
  const context = new ServiceContext({ hosts: ["https://write-handoff.invalid"], session: session("A"),
    invoke: (owner) => { signed.push(owner.delegationCid); return {}; },
    invokeAny: (owner) => { signed.push(owner.delegationCid); return {}; },
    fetch: async () => Response.json({ written: ["note"], count: 1 }),
  });
  const kv = new KVService(); kv.initialize(context);
  kv.setReadThrough({ write: async ({ network }: { network: () => Promise<unknown> }) => {
    entered.resolve(); await ready.promise; return network();
  } } as never);
  const pending = kv.batchPut([{ key: "note", value: "value" }]);
  await entered.promise; context.setSession(session("B")); ready.resolve();
  expect((await pending).ok).toBe(false); expect(signed).toEqual([]);
  context.retire();
});

test("KV authorization metadata keeps the requested space after its body yields", async () => {
  const entered = deferred(); const ready = deferred();
  const context = new ServiceContext({ hosts: ["https://error-handoff.invalid"], session: session("A"), invoke: () => ({}),
    fetch: async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => {
      entered.resolve(); await ready.promise;
      return `Unauthorized Action: ${session("A").spaceId}/kv/note / tinycloud.kv/get`;
    } } as never),
  });
  const kv = new KVService(); kv.initialize(context);
  const pending = kv.get("note"); await entered.promise;
  context.setSession(session("B")); ready.resolve();
  const result = await pending; expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.meta?.resource).toBe(`${session("A").spaceId}/kv/note`);
  context.retire();
});
