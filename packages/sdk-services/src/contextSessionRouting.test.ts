import { expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { KVService } from "./kv/KVService";
import { createResourceRoutingFetch } from "./resourceRouting";
import type { ServiceSession } from "./types";

const session = (name: string): ServiceSession => ({
  delegationHeader: { Authorization: name }, delegationCid: name,
  spaceId: "tinycloud:pkh:eip155:1:0x1:default", verificationMethod: name, jwk: {},
});

test.each(["foreground", "background"] as const)("%s KV request cannot switch signers while its lane loads", async (priority) => {
  const a = session("A");
  const b = session("B");
  const signed: ServiceSession[] = [];
  let sends = 0;
  const context = new ServiceContext({
    hosts: [`https://${priority}-session-switch.invalid`], session: a, priority,
    invoke: (owner) => { signed.push(owner); return {}; },
    fetch: async () => { sends++; return new Response("value"); },
  });
  const kv = new KVService({});
  kv.initialize(context);
  const pending = kv.get("note");
  context.setSession(b);
  expect((await pending).ok).toBe(false);
  expect(signed).not.toContain(b);
  expect(sends).toBe(0);
  expect((await kv.get("note")).ok).toBe(true);
  expect(signed).toEqual([b]);
});

test("routed foreground retries keep the physical host lease through backoff and the final body", async () => {
  const target = "https://resolved-retry.invalid";
  const authorization = `header.${btoa(JSON.stringify({ att: {
    "tinycloud:pkh:eip155:1:0x1:default/kv/note": { "tinycloud.kv/get": [{}] },
  } }))}.signature`;
  let announceFirst!: () => void;
  const first = new Promise<void>((resolve) => { announceFirst = resolve; });
  const requests: string[] = [];
  let attempts = 0;
  const route = (foreground: boolean) => createResourceRoutingFetch(async () => {
    requests.push(foreground ? `foreground-${++attempts}` : "background");
    if (foreground && attempts === 1) {
      announceFirst();
      return new Response("sql_busy: begin: database is locked", { status: 503, headers: { "retry-after": "1" } });
    }
    return foreground ? new Response(new ReadableStream()) : new Response("ok");
  }, {
    resolveResource: async () => [{ url: target }], verifyDestination: async () => undefined,
    bindAudience: async (value) => value,
  });
  const foreground = new ServiceContext({
    hosts: ["https://foreground-hint.invalid"], invoke: () => ({}), fetch: route(true),
    retryPolicy: { maxAttempts: 2, maxTotalMs: 2000 },
  });
  const background = new ServiceContext({
    hosts: ["https://background-hint.invalid"], priority: "background", invoke: () => ({}), fetch: route(false),
  });
  const init = { method: "POST", headers: { Authorization: authorization } };
  const reading = foreground.invokeWithRetry(`${foreground.hosts[0]}/invoke`, () => init);
  await first;
  const syncing = background.fetch(`${background.hosts[0]}/invoke`, init);
  try {
    const response = await reading;
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(requests).toEqual(["foreground-1", "foreground-2"]);
    await response.body!.cancel();
    expect(await (await syncing).text()).toBe("ok");
    expect(requests).toEqual(["foreground-1", "foreground-2", "background"]);
  } finally {
    foreground.retire(); background.retire();
    await Promise.allSettled([reading, syncing]);
  }
});

test("a routed multi-destination write cancels the unreturned body and releases that host's lane", async () => {
  const targets = ["https://write-first.invalid", "https://write-second.invalid"];
  const authorization = `header.${btoa(JSON.stringify({ att: {
    "tinycloud:pkh:eip155:1:0x1:default/kv/note": { "tinycloud.kv/put": [{}] },
  } }))}.signature`;
  const cancelled: string[] = [];
  const context = new ServiceContext({
    hosts: ["https://write-stale.invalid"], invoke: () => ({}),
    fetch: createResourceRoutingFetch(async (url) => new Response(new ReadableStream({
      cancel() { cancelled.push(url); },
    })), {
      resolveResource: async () => targets.map((url) => ({ url })),
      verifyDestination: async () => undefined, bindAudience: async (value) => value,
    }),
  });
  const response = await context.invokeWithRetry(`${context.hosts[0]}/invoke`, () => ({
    method: "POST", headers: { Authorization: authorization }, body: "value",
  }));
  expect(cancelled).toEqual([`${targets[1]}/invoke`]);
  await response.body!.cancel();
  const background = new ServiceContext({
    hosts: [targets[1]], priority: "background", invoke: () => ({}), fetch: async () => new Response("ok"),
  });
  try {
    expect(await (await background.fetch(`${targets[1]}/invoke`)).text()).toBe("ok");
    expect(cancelled).toEqual([`${targets[1]}/invoke`, `${targets[0]}/invoke`]);
  } finally { context.retire(); background.retire(); }
});

test("nested routing wrappers retain caller priority without copying transport credentials", async () => {
  const target = "https://nested-resolved.invalid";
  const authorization = `header.${btoa(JSON.stringify({ att: {
    "tinycloud:pkh:eip155:1:0x1:default/kv/note": { "tinycloud.kv/get": [{}] },
  } }))}.signature`;
  let hint: string | undefined;
  const router = Object.assign(createResourceRoutingFetch(async (_url, init) => {
    hint = init?.priority;
    return new Response("ok");
  }, {
    resolveResource: async () => [{ url: target }], verifyDestination: async () => undefined,
    bindAudience: async (value) => value,
  }), { credentialState: "fixture-private-state" });
  const parent = new ServiceContext({ hosts: [target], invoke: () => ({}), fetch: router });
  expect("credentialState" in parent.fetch).toBe(false);
  const child = new ServiceContext({
    hosts: ["https://nested-stale.invalid"], priority: "background", invoke: () => ({}), fetch: parent.fetch,
  });
  const response = await child.fetch(`${child.hosts[0]}/invoke`, { headers: { Authorization: authorization } });
  expect(await response.text()).toBe("ok");
  expect(hint).toBe("low");
});

test("different stale hints share one background slot at the resolved destination through body consumption", async () => {
  const target = "https://resolved-background.invalid";
  const authorization = `header.${btoa(JSON.stringify({ att: {
    "tinycloud:pkh:eip155:1:0x1:default/kv/note": { "tinycloud.kv/get": [{}] },
  } }))}.signature`;
  let active = 0;
  let maximum = 0;
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const destinations: string[] = [];
  const routed = createResourceRoutingFetch(async (url) => {
    destinations.push(url);
    maximum = Math.max(maximum, ++active);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controllers.push(controller); },
      cancel() { active--; },
    }));
  }, {
    resolveResource: async () => [{ url: target }],
    verifyDestination: async () => undefined,
    bindAudience: async (value) => value,
  });
  const contexts = ["https://stale-one.invalid", "https://stale-two.invalid"].map((hint) => new ServiceContext({
    hosts: [hint], priority: "background", invoke: () => ({}), fetch: routed,
  }));
  const requests = contexts.map((context) => context.fetch(`${context.hosts[0]}/invoke`, {
    method: "POST", headers: { Authorization: authorization },
  }));
  try {
    const first = await requests[0];
    // Both calls have entered the async routing/dispatch chain. The first body
    // stays open until the consumer cancels it, independently of header arrival.
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(destinations).toEqual([`${target}/invoke`]);
    expect(maximum).toBe(1);
    await first.body!.cancel();
    const second = await requests[1];
    expect(destinations).toEqual([`${target}/invoke`, `${target}/invoke`]);
    expect(maximum).toBe(1);
    await second.body!.cancel();
    expect(active).toBe(0);
  } finally {
    contexts.forEach((context) => context.retire());
    controllers.forEach((controller) => { try { controller.error(new Error("fixture complete")); } catch {} });
    await Promise.allSettled(requests);
  }
});
