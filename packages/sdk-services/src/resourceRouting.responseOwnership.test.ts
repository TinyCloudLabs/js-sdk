import { expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { createResourceRoutingFetch, createResourceTransportInvocationFetch, routeResourceRequest, type ResourceTransport } from "./resourceRouting";
import type { FetchFunction, ServiceSession } from "./types";

const space = "tinycloud:pkh:eip155:1:0x1:default";
const authorization = ["header", btoa(JSON.stringify({ att: { [`${space}/kv/note`]: { "tinycloud.kv/put": [{}] } } })), "signature"].join(".");
const session = { spaceId: space } as ServiceSession;

for (const { adapter, concurrent } of [
  { adapter: "routing", concurrent: false }, { adapter: "resource transport", concurrent: false },
  { adapter: "resource transport", concurrent: true },
] as const) {
  test(`${adapter} (${concurrent ? "parallel" : "sequential"}): an intermediate write body releases its host slot before fanout`, async () => {
    const host = `https://fanout-${adapter.replaceAll(" ", "-")}-${concurrent}.invalid`;
    const targets = [{ url: `${host}/first` }, { url: `${host}/second` }];
    let requests = 0;
    const replies: Response[] = [];
    const raw: FetchFunction = async () => {
      requests++;
      const reply = new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i]));
        controller.close();
      } }));
      replies.push(reply);
      return reply;
    };
    const routing = {
      resolveResource: async () => targets,
      verifyDestination: async () => {},
      bindAudience: async (value: string) => value,
    };
    let selected: unknown;
    const transport: ResourceTransport = async (resources, send, options) => {
      const targetSend = (target: typeof targets[number]) => send({ ...target, fetch: raw, bindAudience: async (value) => value });
      selected = concurrent ? (await Promise.all(targets.map(targetSend)))[0] : await routeResourceRequest(resources, routing, targetSend, options);
      return selected as Awaited<ReturnType<FetchFunction>>;
    };
    const fetch = adapter === "routing"
      ? createResourceRoutingFetch(raw, routing)
      : createResourceTransportInvocationFetch(transport, session);
    const context = new ServiceContext({ hosts: ["https://stale.invalid"], priority: "background", invoke: () => ({}), fetch });
    try {
      const response = await context.fetch("https://stale.invalid/invoke", {
        method: "POST", headers: { Authorization: authorization }, signal: AbortSignal.timeout(1500),
      });
      expect(requests).toBe(2);
      if (adapter === "resource transport") expect(response).toBe(selected);
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(replies[0]!.bodyUsed).toBe(true);
      // A third request can use the same host after the unselected receipt is discarded.
      const sibling = new ServiceContext({ hosts: [host], priority: "background", invoke: () => ({}), fetch: async () => new Response("next") });
      try { expect(await (await sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1500) })).text()).toBe("next"); }
      finally { sibling.retire(); }
    } finally { context.retire(); }
  });
}

test("a rejected SDK fetch adapter disposes a response that arrives after its transport rejected", async () => {
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled = 0;
  let sent!: Promise<Awaited<ReturnType<FetchFunction>>>;
  const raw: FetchFunction = async () => {
    entered(); await ready;
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i])); controller.close();
    }, cancel() { cancelled++; } }));
  };
  const reason = new Error("transport rejected before its pending fetch");
  const transport: ResourceTransport = async (_resources, send) => {
    sent = send({ url: "https://late-owned.invalid", fetch: raw, bindAudience: async (value) => value });
    void sent.catch(() => {});
    throw reason;
  };
  const context = new ServiceContext({ hosts: ["https://stale.invalid"], priority: "background", invoke: () => ({}),
    fetch: createResourceTransportInvocationFetch(transport, session) });
  const sibling = new ServiceContext({ hosts: ["https://late-owned.invalid"], priority: "background", invoke: () => ({}), fetch: async () => new Response("next") });
  try {
    const failed = context.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: authorization } }).catch((error) => error);
    await started;
    expect(await failed).toBe(reason);
    const next = sibling.fetch("https://late-owned.invalid/invoke", { signal: AbortSignal.timeout(1500) }).then((response) => response.text());
    void next.catch(() => {});
    release(); await sent;
    expect(cancelled).toBe(1);
    expect(await next).toBe("next");
  } finally { release(); context.retire(); sibling.retire(); }
});
