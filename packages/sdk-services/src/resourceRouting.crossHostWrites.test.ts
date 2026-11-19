import { expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { createResourceRoutingFetch } from "./resourceRouting";
import type { FetchFunction } from "./types";

const space = "tinycloud:pkh:eip155:1:0x1:default";
const authorization = ["header", btoa(JSON.stringify({ att: { [`${space}/kv/note`]: { "tinycloud.kv/put": [{}] } } })), "signature"].join(".");

test("background writes that visit two hosts in opposite orders both complete", async () => {
  const hosts = ["https://cross-write-a.invalid", "https://cross-write-b.invalid"];
  // Hold both first replies until each write has one, so each write holds one host when it moves to the other.
  let arrived = 0;
  let bothArrived!: () => void;
  const firstReplies = new Promise<void>((resolve) => { bothArrived = resolve; });
  const raw: FetchFunction = async () => {
    if (++arrived === 2) bothArrived();
    if (arrived <= 2) await firstReplies;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    } }));
  };
  const write = (order: string[]) => {
    const routing = {
      resolveResource: async () => order.map((url) => ({ url })),
      verifyDestination: async () => {},
      bindAudience: async (value: string) => value,
    };
    return new ServiceContext({ hosts: ["https://stale.invalid"], priority: "background", invoke: () => ({}),
      fetch: createResourceRoutingFetch(raw, routing) });
  };
  const forward = write(hosts);
  const reverse = write([...hosts].reverse());
  try {
    const responses = await Promise.all([forward, reverse].map((context) => context.fetch("https://stale.invalid/invoke", {
      method: "POST", headers: { Authorization: authorization }, signal: AbortSignal.timeout(3_000),
    })));
    expect(arrived).toBe(4);
    for (const response of responses) expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
  } finally {
    forward.retire();
    reverse.retire();
  }
});
