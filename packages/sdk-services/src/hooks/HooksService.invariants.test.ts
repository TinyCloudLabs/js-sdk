// Hooks stream liveness, lifecycle, and confidentiality invariants.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceContext } from "../context";
import { HooksService } from "./HooksService";
import type { FetchRequestInit, FetchResponse, IServiceContext } from "../types";
import type { HookEvent } from "./types";

const TICKET = "tick et+/=";
const FORMS = [
  TICKET,
  encodeURIComponent(TICKET),
  new URLSearchParams({ ticket: TICKET }).toString().slice("ticket=".length),
];
const INVOCATION = "Bearer invocation-secret";
const EVENT = JSON.stringify({
  id: "evt-1",
  space: "space-123",
  service: "kv",
  ability: "tinycloud.kv/put",
  path: "a",
  actor: "did:key:actor",
  epoch: "e",
  eventIndex: 1,
  timestamp: "t",
});
const turn = () => new Promise<void>((r) => setTimeout(r, 0));
const activeServices = new Set<HooksService>();
function initialize(service: HooksService, context: IServiceContext): void {
  service.initialize(context);
  activeServices.add(service);
}

// Bun runs afterEach even when an assertion fails, so a leaked stream cannot
// keep its supervisor alive or interfere with the next invariant.
afterEach(() => {
  for (const service of activeServices) service.onSignOut();
  activeServices.clear();
});
const url = (t: string) => `https://node.tinycloud.xyz/hooks/events?ticket=${t}`;

/** One SSE body: an event, then open until the request aborts. */
function liveBody(signal?: AbortSignal, poison?: () => never): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (poison) {
        controller.error(
          new Error(`terminated reading ${url(encodeURIComponent(TICKET))}`),
        );
        return;
      }
      controller.enqueue(new TextEncoder().encode(`data: ${EVENT}\n\n`));
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
}

type Fault = (seam: string, init?: { signal?: AbortSignal }) => unknown;

function deepCause(depth: number): Error {
  let e = new Error(`root ${url(TICKET)}`);
  for (let i = 0; i < depth; i += 1) e = Object.assign(new Error("wrap"), { cause: e });
  return e;
}

/** Each fault fires on the first visit to its seam, then heals. */
const FAULTS: Record<string, { seam: string; act: () => unknown }> = {
  "mint rejects with invocation header in message": { seam: "mint", act: () => { throw new Error(`POST failed with headers ${INVOCATION}`); } },
  "mint 500": { seam: "mint", act: () => new Response("down", { status: 500 }) },
  "mint 429": { seam: "mint", act: () => new Response("slow down", { status: 429 }) },
  "mint ticket missing": { seam: "mint", act: () => new Response(JSON.stringify({ ticket: 42 }), { status: 200 }) },
  "mint json rejects": { seam: "mint", act: () => ({ ok: true, status: 200, json: () => Promise.reject(new Error(INVOCATION)) }) },
  "open rejects with URL": { seam: "open", act: () => { throw new Error(`request to ${url(TICKET)} failed`); } },
  "open rejects with deep cause chain": { seam: "open", act: () => { throw deepCause(12); } },
  "open rejects with non-Error cause object": { seam: "open", act: () => { throw Object.assign(new Error("x"), { cause: { request: { url: url(TICKET) } } }); } },
  "open rejects with circular meta": { seam: "open", act: () => { const meta: Record<string, unknown> = { url: url(TICKET) }; meta.self = meta; throw Object.assign(new Error("x"), { meta }); } },
  "open rejects with throwing toJSON meta": { seam: "open", act: () => { throw Object.assign(new Error("x"), { meta: { u: url(TICKET), toJSON() { throw new Error(url(TICKET)); } } }); } },
  "open rejects with throwing meta getter": { seam: "open", act: () => { const e = { code: "X", message: "m", service: "s" }; Object.defineProperty(e, "meta", { get() { throw new Error(url(TICKET)); } }); throw e; } },
  "open rejects with ServiceError-shaped circular meta": { seam: "open", act: () => { const meta: Record<string, unknown> = { url: url(TICKET) }; meta.self = meta; throw { code: "X", message: "m", service: "s", meta }; } },
  "open rejects with ServiceError-shaped throwing toJSON meta": { seam: "open", act: () => { throw { code: "X", message: "m", service: "s", meta: { u: { href: url(TICKET), toJSON() { throw new Error("no"); } } } }; } },
  "open rejects with throwing name getter": { seam: "open", act: () => { const e = new Error(url(TICKET)); Object.defineProperty(e, "name", { get() { throw new Error(url(TICKET)); } }); throw e; } },
  "open rejects with revoked proxy": { seam: "open", act: () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); throw proxy; } },
  "open rejects with ticket as name": { seam: "open", act: () => { throw Object.assign(new Error("x"), { name: TICKET }); } },
  "open rejects with secret transport code": { seam: "open", act: () => { throw Object.assign(new Error("x"), { code: "TICKET_SECRET_42" }); } },
  "open rejects with authorization code": { seam: "open", act: () => { throw Object.assign(new Error("x"), { code: INVOCATION }); } },
  "open rejects with constructor name": { seam: "open", act: () => { throw Object.assign(new Error("x"), { name: "constructor" }); } },
  "open rejects with proto name": { seam: "open", act: () => { throw Object.assign(new Error("x"), { name: "__proto__" }); } },
  "open 503": { seam: "open", act: () => new Response("down", { status: 503 }) },
  "read errors with URL": { seam: "read", act: () => "poison" },
  "read malformed event": { seam: "read", act: () => "malformed" },
  "context.isAuthenticated throws": { seam: "ctx:isAuthenticated", act: () => { throw new Error(url(TICKET)); } },
  "context.abortSignal throws": { seam: "ctx:abortSignal", act: () => { throw new Error(url(TICKET)); } },
  "context.hosts throws": { seam: "ctx:hosts", act: () => { throw new Error("hosts"); } },
  "context.invoke throws": { seam: "ctx:invoke", act: () => { throw new Error(INVOCATION); } },
  "streamRetry.delay throws": { seam: "delay", act: () => { throw new Error("delay"); } },
  "streamRetry.wait throws": { seam: "wait", act: () => { throw new Error("wait"); } },
  "streamRetry.wait rejects": { seam: "wait", act: () => Promise.reject(new Error("wait")) },
};

type FaultSpec = { seam: string; act: () => unknown };
function harness(spec?: FaultSpec | FaultSpec[], emitThrows = false) {
  const faults = spec === undefined ? [] : Array.isArray(spec) ? spec : [spec];
  const fired = new Set<string>();
  let fault: FaultSpec | undefined;
  const once = (seam: string): boolean => {
    const match = faults.find((f) => f.seam === seam);
    if (!match || fired.has(seam)) return false;
    fired.add(seam);
    fault = match;
    return true;
  };
  const stats = { mints: 0, opens: 0, active: 0, maxActive: 0, mintsInFlight: 0, maxMintsInFlight: 0 };
  const emitted: unknown[] = [];
  const contextAbort = new AbortController();
  const fetch: IServiceContext["fetch"] = async (u, init) => {
    await turn();
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (u.includes("/hooks/tickets")) {
      stats.mints += 1;
      stats.mintsInFlight += 1;
      stats.maxMintsInFlight = Math.max(stats.maxMintsInFlight, stats.mintsInFlight);
      try {
        await turn();
        if (once("mint")) return fault!.act() as FetchResponse;
        return new Response(JSON.stringify({ ticket: TICKET, expiresAt: "x" }), { status: 200 }) as FetchResponse;
      } finally {
        stats.mintsInFlight -= 1;
      }
    }
    stats.opens += 1;
    if (once("open")) return fault!.act() as FetchResponse;
    const readFault = once("read") ? (fault!.act() as string) : undefined;
    if (readFault === "malformed") {
      return new Response("data: {not json\n\n", { status: 200 }) as FetchResponse;
    }
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    init?.signal?.addEventListener("abort", () => { stats.active -= 1; }, { once: true });
    return new Response(liveBody(init?.signal, readFault ? (() => { throw 0; }) as () => never : undefined), { status: 200 }) as FetchResponse;
  };
  const abortSignal = contextAbort.signal;
  let authReads = 0;
  const context: IServiceContext = {
    session: { delegationHeader: { Authorization: INVOCATION }, delegationCid: "c", spaceId: "space-123", verificationMethod: "did:key:t", jwk: {} },
    // The first read is subscribe()'s own precondition; fault the supervisor's reads.
    get isAuthenticated() { authReads += 1; if (authReads > 1 && once("ctx:isAuthenticated")) fault!.act(); return true; },
    invoke: () => { if (once("ctx:invoke")) fault!.act(); return { Authorization: INVOCATION }; },
    invokeAny: undefined,
    fetch,
    get hosts() { if (once("ctx:hosts")) fault!.act(); return ["https://node.tinycloud.xyz"]; },
    getService: () => undefined,
    emit: (event, data) => { if (event === "service.error") emitted.push(data); if (emitThrows) throw new Error(url(TICKET)); },
    on: () => () => undefined,
    get abortSignal() { if (once("ctx:abortSignal")) fault!.act(); return abortSignal; },
    retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
  } as IServiceContext;
  const service = new HooksService({
    host: undefined,
    streamRetry: {
      delay: (attempt) => { if (once("delay")) fault!.act(); return attempt; },
      wait: (ms, _attempt, signal) => {
        if (once("wait")) return fault!.act() as Promise<void>;
        // Injected clock: one event-loop turn stands in for the delay.
        return turn();
      },
    },
  });
  initialize(service, context);
  return { service, stats, emitted, context, contextAbort };
}

function serialize(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[cycle]";
      seen.add(v);
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack, cause: v.cause, properties: Object.assign({}, v) };
    }
    return v;
  });
}

async function firstEvent(iterator: AsyncIterator<unknown>, turns = 3000) {
  const next = iterator.next();
  let settled: unknown;
  next.then((v) => (settled = { v }), (e) => (settled = { e }));
  for (let i = 0; i < turns && settled === undefined; i += 1) await turn();
  return settled as { v?: IteratorResult<unknown>; e?: unknown } | undefined;
}

describe("supervisor invariants under single faults", () => {
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on("unhandledRejection", onUnhandledRejection);

  for (const [name, fault] of Object.entries(FAULTS)) {
    test(name, async () => {
      const before = rejections.length;
      const { service, stats, emitted } = harness(fault);
      const stop = new AbortController();
      const iterator = service
        .subscribe([{ space: "space-123", service: "kv" }], { signal: stop.signal })
        [Symbol.asyncIterator]();
      const result = await firstEvent(iterator);
      // Liveness: the subscriber gets the event once the fault heals.
      expect(result?.v?.value).toMatchObject({ id: "evt-1" });
      // Confidentiality: no ticket form, no invocation header in telemetry.
      const telemetry = serialize(emitted);
      for (const form of FORMS) expect(telemetry).not.toContain(form);
      expect(telemetry).not.toContain("invocation-secret");
      expect(telemetry).not.toContain("TICKET_SECRET_42");
      expect(telemetry).not.toContain(INVOCATION);
      if (name.includes("constructor name") || name.includes("proto name")) {
        expect(telemetry).toContain('"errorName":"Error"');
      }
      // Exactly one stream / mint at a time.
      expect(stats.maxActive).toBeLessThanOrEqual(1);
      expect(stats.maxMintsInFlight).toBeLessThanOrEqual(1);
      stop.abort();
      await iterator.return?.();
      for (let i = 0; i < 5; i += 1) await turn();
      expect(rejections.length).toBe(before);
    });
  }
  afterAll(() => process.off("unhandledRejection", onUnhandledRejection));

  test("emit that always throws does not steer the stream", async () => {
    const { service } = harness(FAULTS["open 503"], true);
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(iterator))?.v?.value).toMatchObject({ id: "evt-1" });
    await iterator.return?.();
  });
});

describe("structural invariants", () => {

  test("terminal mint refusal surfaces ServiceError with meta.status and does not re-mint", async () => {
    const { service, stats } = harness({ seam: "mint", act: () => new Response("scopes not covered", { status: 403, statusText: "Forbidden" }) });
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const result = await firstEvent(iterator);
    expect(result?.e).toMatchObject({ service: "hooks", meta: { status: 403 } });
    expect((result?.e as { message: string }).message).toBe("failed to mint hook ticket: 403 scopes not covered");
    for (let i = 0; i < 20; i += 1) await turn();
    expect(stats.mints).toBe(1);
  });
  test.each([400, 401, 403, 404])("mint %i is terminal after one mint", async (status) => {
    const { service, stats } = harness({
      seam: "mint",
      act: () => new Response("terminal refusal", { status }),
    });
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const result = await firstEvent(iterator);
    expect(result?.e).toMatchObject({ service: "hooks", meta: { status } });
    for (let i = 0; i < 10; i += 1) await turn();
    expect(stats.mints).toBe(1);
    expect(stats.opens).toBe(0);
  });

  test.each([408, 429, 500, 503])("mint %i retries and delivers the healed event", async (status) => {
    const { service, stats } = harness({
      seam: "mint",
      act: () => new Response("retry", { status }),
    });
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(iterator))?.v?.value).toMatchObject({ id: "evt-1" });
    expect(stats.mints).toBe(2);
    expect(stats.opens).toBe(1);
    await iterator.return?.();
  });

  test.each([401, 403])("open %i remints and delivers the healed event", async (status) => {
    const { service, stats } = harness({
      seam: "open",
      act: () => new Response(`refused ${url(TICKET)}`, { status }),
    });
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(iterator))?.v?.value).toMatchObject({ id: "evt-1" });
    expect(stats.mints).toBe(2);
    expect(stats.opens).toBe(2);
    await iterator.return?.();
  });

  test("subscriber churn and session changes never run two streams", async () => {
    const { service, stats } = harness();
    const stops: AbortController[] = [];
    const iterators: AsyncIterator<unknown>[] = [];
    for (let i = 0; i < 60; i += 1) {
      const stop = new AbortController();
      stops.push(stop);
      const it = service.subscribe([{ space: "space-123", service: "kv", pathPrefix: `p${i % 4}` }], { signal: stop.signal })[Symbol.asyncIterator]();
      iterators.push(it);
      void it.next().catch(() => undefined);
      if (i % 3 === 0) stops[(i / 3) % stops.length]!.abort();
      if (i % 7 === 0) service.onSessionChange(null as never);
      for (let t = 0; t < (i % 5); t += 1) await turn();
    }
    for (let t = 0; t < 50; t += 1) await turn();
    expect(stats.maxActive).toBeLessThanOrEqual(1);
    expect(stats.maxMintsInFlight).toBeLessThanOrEqual(1);
    for (const stop of stops) stop.abort();
    for (let t = 0; t < 20; t += 1) await turn();
    expect(stats.active).toBe(0);
  });

  test("a clock that never fires still yields to unsubscribe, and the next subscriber gets a fresh supervisor", async () => {
    const { service, stats } = harness([FAULTS["open 503"], { seam: "wait", act: () => new Promise(() => {}) }]);
    const stop = new AbortController();
    const first = service.subscribe([{ space: "space-123", service: "kv" }], { signal: stop.signal })[Symbol.asyncIterator]();
    const pending = first.next();
    // Force a failure so the loop parks in the never-firing wait.
    for (let t = 0; t < 20; t += 1) await turn();
    stop.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    for (let t = 0; t < 5; t += 1) await turn();
    const second = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(second))?.v?.value).toMatchObject({ id: "evt-1" });
    void stats;
    await second.return?.();
  });

  test("context abort during backoff completes the iterator promptly", async () => {
    const { service, stats, contextAbort } = harness([
      FAULTS["open 503"],
      { seam: "wait", act: () => new Promise<void>(() => {}) },
    ]);
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const pending = iterator.next();
    for (let i = 0; i < 30; i += 1) await turn();
    contextAbort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    const fetches = stats.mints + stats.opens;
    for (let i = 0; i < 10; i += 1) await turn();
    expect(stats.mints + stats.opens).toBe(fetches);
  });

  test("sign-out completes iterators and stops all I/O", async () => {
    const { service, stats } = harness();
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(iterator))?.v?.value).toMatchObject({ id: "evt-1" });
    const pending = iterator.next();
    service.onSignOut();
    expect(await pending).toEqual({ value: undefined, done: true });
    for (let t = 0; t < 10; t += 1) await turn();
    const fetches = stats.mints + stats.opens;
    for (let t = 0; t < 30; t += 1) await turn();
    expect(stats.mints + stats.opens).toBe(fetches);
    expect(stats.active).toBe(0);
  });
});
describe("gated lifecycle transitions", () => {
  const phases = ["mint", "open", "read", "backoff"] as const;
  const transitions = [
    "last unsubscribe",
    "sign-out",
    "context abort",
    "signature change",
    "session change",
    "A→B→A",
  ] as const;

  for (const phase of phases) {
    for (const transition of transitions) {
      test(`${phase}: ${transition} discards stale work`, async () => {
        let releaseGate!: () => void;
        let enterGate!: () => void;
        const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
        const entered = new Promise<void>((resolve) => { enterGate = resolve; });
        let mints = 0;
        let opens = 0;
        let gated = false;
        let readEntered = false;
        let bodyCancelled = false;
        const emitted: unknown[] = [];
        const contextAbort = new AbortController();
        let contextSession = { delegationHeader: { Authorization: INVOCATION }, delegationCid: "c", spaceId: "space-123", verificationMethod: "did:key:t", jwk: {} };
        const context: IServiceContext = {
          get session() { return contextSession; },
          isAuthenticated: true,
          invoke: () => ({ Authorization: INVOCATION }),
          invokeAny: () => ({ Authorization: INVOCATION }),
          hosts: ["https://node.tinycloud.xyz"],
          get abortSignal() { return contextAbort.signal; },
          getService: () => undefined,
          emit: (_event, data) => { emitted.push(data); },
          on: () => () => undefined,
          retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
          fetch: async (requestUrl, init) => {
            if (requestUrl.includes("/hooks/tickets")) {
              mints += 1;
              if (phase === "mint" && mints === 1) {
                gated = true;
                enterGate();
                await gate;
                if (transition === "context abort" && init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
                return new Response("old terminal refusal", { status: 403 });
              }
              return new Response(JSON.stringify({ ticket: `ticket-${mints}` }));
            }
            opens += 1;
            if (phase === "open" && opens === 1) {
              gated = true;
              enterGate();
              await gate;
              if (transition === "context abort" && init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
              return new Response("old refusal", { status: 401 });
            }
            if (phase === "read" && opens === 1) {
              gated = true;
              return {
                ok: true,
                status: 200,
                body: {
                  [Symbol.asyncIterator]() {
                    return {
                      async next() {
                        if (!readEntered) {
                          readEntered = true;
                          enterGate();
                          await gate;
                          return {
                            done: false as const,
                            value: new TextEncoder().encode(`data: ${JSON.stringify({ ...JSON.parse(EVENT), id: "stale-event" })}\n\n`),
                          };
                        }
                        return { done: true as const, value: undefined };
                      },
                      return() {
                        bodyCancelled = true;
                        return Promise.resolve({ done: true as const, value: undefined });
                      },
                    };
                  },
                },
              } as FetchResponse;
            }
            if (phase === "backoff" && opens === 1) {
              return new Response("retry", { status: 503 });
            }
            return new Response(`data: ${EVENT}\n\n`, { status: 200 });
          },
        } as IServiceContext;
        const service = new HooksService({
          streamRetry: {
            delay: () => 0,
            wait: async () => {
              if (phase === "backoff" && !gated) {
                gated = true;
                enterGate();
                await gate;
              }
            },
          },
        });
        initialize(service, context);
        const stopA = new AbortController();
        const iteratorA = service.subscribe(
          [{ space: "space-123", service: "kv" }],
          { signal: stopA.signal, ttlSeconds: 5 },
        )[Symbol.asyncIterator]();
        const pendingA = iteratorA.next();
        await entered;

        let pendingB: Promise<IteratorResult<HookEvent>> | undefined;
        let stopB: AbortController | undefined;
        if (transition === "last unsubscribe") {
          stopA.abort();
        } else if (transition === "sign-out") {
          service.onSignOut();
        } else if (transition === "context abort") {
          contextAbort.abort();
        } else if (transition === "signature change") {
          const iteratorB = service.subscribe(
            [{ space: "space-123", service: "kv", abilities: ["tinycloud.kv/put"] }],
            { ttlSeconds: 10 },
          )[Symbol.asyncIterator]();
          pendingB = iteratorB.next();
        } else if (transition === "session change") {
          contextSession = { ...contextSession, delegationCid: "next-session" };
          service.onSessionChange(contextSession);
        } else {
          stopB = new AbortController();
          const iteratorB = service.subscribe(
            [{ space: "space-123", service: "kv", abilities: ["tinycloud.kv/put"] }],
            { signal: stopB.signal, ttlSeconds: 10 },
          )[Symbol.asyncIterator]();
          pendingB = iteratorB.next();
          stopB.abort();
          expect(await pendingB).toEqual({ value: undefined, done: true });
        }

        if (transition === "last unsubscribe" || transition === "sign-out" || transition === "context abort") {
          expect(await pendingA).toEqual({ value: undefined, done: true });
        } else {
          const receivedA = await pendingA;
          expect(receivedA.value?.id).toBe("evt-1");
          expect(receivedA.value?.id).not.toBe("stale-event");
          if (transition === "signature change") {
            expect((await pendingB)?.value?.id).toBe("evt-1");
          }
        }
        if (phase === "read") expect(bodyCancelled).toBe(true);
        releaseGate();
        for (let i = 0; i < 20; i += 1) await turn();
        expect(gated).toBe(true);
        expect(emitted).toHaveLength(phase === "backoff" ? 1 : 0);
        const stopped = transition === "last unsubscribe" || transition === "sign-out" || transition === "context abort";
        const settledFetches = mints + opens;
        for (let i = 0; i < 10; i += 1) await turn();
        if (stopped) expect(mints + opens).toBe(settledFetches);
        service.onSignOut();
      });
    }
  }

  test("an already-aborted context completes without starting I/O", async () => {
    const { service, stats, contextAbort } = harness();
    contextAbort.abort();
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(stats.mints).toBe(0);
    expect(stats.opens).toBe(0);
  });
});

describe("pacing invariants", () => {
  test.each(["noop", "throw", "reject"] as const)("fairness yields after a %s wait", async (mode) => {
    let opens = 0;
    let timerFired = false;
    const context: IServiceContext = {
      session: { delegationHeader: { Authorization: INVOCATION }, delegationCid: "c", spaceId: "space-123", verificationMethod: "did:key:t", jwk: {} },
      isAuthenticated: true,
      invoke: () => ({ Authorization: INVOCATION }),
      invokeAny: undefined,
      hosts: ["https://node.tinycloud.xyz"],
      getService: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
      abortSignal: new AbortController().signal,
      retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
      fetch: async (u) => {
        if (u.includes("/hooks/tickets")) return new Response('{"ticket":"t"}');
        opens += 1;
        return new Response("down", { status: 503 });
      },
    };
    const service = new HooksService({
      streamRetry: {
        delay: () => 0,
        wait: () => {
          if (mode === "throw") throw new Error("wait");
          if (mode === "reject") return Promise.reject(new Error("wait"));
          return Promise.resolve();
        },
      },
    });
    initialize(service, context);
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const pending = iterator.next();
    await timer;
    expect(timerFired).toBe(true);
    expect(opens).toBeLessThan(100);
    service.onSignOut();
    await pending;
  });
});

describe("fresh subscription after terminal refusal", () => {
  test("a later subscriber mints again after the prior iterator received a terminal error", async () => {
    const { service, stats } = harness({
      seam: "mint",
      act: () => new Response("forbidden", { status: 403 }),
    });
    const first = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(first))?.e).toMatchObject({ service: "hooks", meta: { status: 403 } });
    const second = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(second))?.v?.value).toMatchObject({ id: "evt-1" });
    expect(stats.mints).toBe(2);
    expect(stats.opens).toBe(1);
    await second.return?.();
  });
});

describe("stale mint discard", () => {
  test("a superseded 403 cannot refuse the new merged plan", async () => {
    let resolveMint!: () => void;
    let mintEntered!: () => void;
    const delayed = new Promise<void>((resolve) => { resolveMint = resolve; });
    const entered = new Promise<void>((resolve) => { mintEntered = resolve; });
    const base = harness();
    const baseFetch = base.context.fetch;
    let firstMint = true;
    const context: IServiceContext = {
      ...base.context,
      fetch: async (url, init) => {
        if (url.includes("/hooks/tickets") && firstMint) {
          firstMint = false;
          base.stats.mints += 1;
          mintEntered();
          await delayed;
          return new Response("superseded", { status: 403 });
        }
        return baseFetch(url, init);
      },
    };
    const service = new HooksService({ streamRetry: { delay: () => 0, wait: async () => turn() } });
    initialize(service, context);
    const first = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const firstPending = first.next();
    await entered;
    const second = service.subscribe(
      [{ space: "space-123", service: "kv" }],
      { ttlSeconds: 10 },
    )[Symbol.asyncIterator]();
    const secondPending = second.next();
    resolveMint();
    expect((await firstPending).value?.id).toBe("evt-1");
    expect((await secondPending).value?.id).toBe("evt-1");
    expect(base.stats.mints).toBe(2);
    expect(base.stats.opens).toBe(1);
    expect(base.emitted).toHaveLength(0);
    await first.return?.();
    await second.return?.();
  });
});

describe("attempt ownership checkpoints", () => {
  test("late mint 403 after context abort completes without rejection", async () => {
    let releaseMint!: (response: Response) => void;
    let enteredMint!: () => void;
    const mint = new Promise<Response>((resolve) => { releaseMint = resolve; });
    const entered = new Promise<void>((resolve) => { enteredMint = resolve; });
    const base = harness();
    const contextAbort = new AbortController();
    const context = {
      ...base.context,
      abortSignal: contextAbort.signal,
      fetch: async (requestUrl: string, init?: FetchRequestInit) => {
        if (requestUrl.includes("/hooks/tickets")) {
          enteredMint();
          return mint as Promise<FetchResponse>;
        }
        return base.context.fetch(requestUrl, init);
      },
    } as IServiceContext;
    const service = new HooksService({ streamRetry: { delay: () => 30_000 } });
    initialize(service, context);
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const pending = iterator.next();
    await entered;
    contextAbort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    releaseMint(new Response("late refusal", { status: 403 }));
    await turn();
    expect(base.emitted).toHaveLength(0);
  });

  test("late successful mint after a plan change never opens its ticket", async () => {
    let releaseMint!: (response: Response) => void;
    let enteredMint!: () => void;
    let lateBodyCancelled = false;
    const mint = new Promise<Response>((resolve) => { releaseMint = resolve; });
    const entered = new Promise<void>((resolve) => { enteredMint = resolve; });
    const base = harness();
    let mints = 0;
    const context = {
      ...base.context,
      fetch: async (requestUrl: string, init?: FetchRequestInit) => {
        if (requestUrl.includes("/hooks/tickets")) {
          mints += 1;
          if (mints === 1) {
            enteredMint();
            return mint as Promise<FetchResponse>;
          }
        }
        return base.context.fetch(requestUrl, init);
      },
    } as IServiceContext;
    const service = new HooksService({ streamRetry: { delay: () => 0, wait: () => turn() } });
    initialize(service, context);
    const first = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const firstPending = first.next();
    await entered;
    const second = service.subscribe(
      [{ space: "space-123", service: "kv" }],
      { ttlSeconds: 10 },
    )[Symbol.asyncIterator]();
    expect((await firstEvent(second))?.v?.value).toMatchObject({ id: "evt-1" });
    const lateBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ticket: "old-ticket" })));
      },
      cancel() { lateBodyCancelled = true; },
    });
    releaseMint(new Response(lateBody));
    await turn();
    expect(lateBodyCancelled).toBe(true);
    expect((await firstPending).value?.id).toBe("evt-1");
    expect(base.stats.opens).toBe(1);
    expect(base.emitted).toHaveLength(0);
    await first.return?.();
    await second.return?.();
  });

  test("a session change during event parsing blocks dispatch from the old stream", async () => {
    const session = {
      delegationHeader: { Authorization: INVOCATION },
      delegationCid: "c",
      spaceId: "space-123",
      verificationMethod: "did:key:t",
      jwk: {},
    };
    let opens = 0;
    let changed = false;
    const context = new ServiceContext({
      hosts: ["https://node.tinycloud.xyz"],
      session,
      invoke: () => ({ Authorization: INVOCATION }),
      fetch: async (requestUrl) => {
        if (requestUrl.includes("/hooks/tickets")) return new Response('{"ticket":"t"}');
        opens += 1;
        const id = opens === 1 ? "old-dispatch-event" : "new-dispatch-event";
        return new Response(`data: ${JSON.stringify({ ...JSON.parse(EVENT), id })}\n\n`);
      },
    });
    const service = new HooksService({ streamRetry: { delay: () => 0, wait: () => turn() } });
    context.registerService("hooks", service);
    initialize(service, context);
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const originalParse = JSON.parse;
    const json = JSON as unknown as { parse(text: string): unknown };
    json.parse = (text: string): unknown => {
      const parsed = originalParse(text);
      if (!changed && text.includes('"id":"old-dispatch-event"')) {
        changed = true;
        context.setSession({ ...session, delegationCid: "new-session" });
      }
      return parsed;
    };
    let received: { v?: IteratorResult<unknown>; e?: unknown } | undefined;
    try {
      received = await firstEvent(iterator);
    } finally {
      json.parse = originalParse;
    }
    expect(changed).toBe(true);
    expect(received?.v?.value).toMatchObject({ id: "new-dispatch-event" });
    expect(received?.v?.value).not.toMatchObject({ id: "old-dispatch-event" });
    expect(opens).toBe(2);
    await iterator.return?.();
  });

  test("cleanup-time abort listener cannot fail a new scope with the old refusal", async () => {
    const base = harness();
    let mints = 0;
    let cleanupListenerCalled = false;
    let scopeB: AsyncIterator<HookEvent> | undefined;
    let scopeBNext: Promise<IteratorResult<HookEvent>> | undefined;
    let service: HooksService;
    const context = {
      ...base.context,
      invokeAny: () => ({ Authorization: INVOCATION }),
      fetch: async (requestUrl: string, init?: FetchRequestInit) => {
        if (requestUrl.includes("/hooks/tickets")) {
          mints += 1;
          if (mints === 1) {
            init?.signal?.addEventListener("abort", () => {
              cleanupListenerCalled = true;
              scopeB = service.subscribe([
                { space: "space-123", service: "kv", abilities: ["tinycloud.kv/put"] },
              ])[Symbol.asyncIterator]();
              scopeBNext = scopeB.next();
            }, { once: true });
            return new Response("old refusal", { status: 403 });
          }
        }
        return base.context.fetch(requestUrl, init);
      },
    } as IServiceContext;
    service = new HooksService({ streamRetry: { delay: () => 0, wait: () => turn() } });
    initialize(service, context);
    const first = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    const firstResult = await firstEvent(first, 500);
    expect(cleanupListenerCalled).toBe(true);
    expect(firstResult?.v?.value).toMatchObject({ id: "evt-1" });
    expect((await scopeBNext)?.value?.id).toBe("evt-1");
    expect(mints).toBe(2);
    expect(base.emitted).toHaveLength(0);
    await first.return?.();
    await scopeB?.return?.();
  });
});

describe("session stream ownership through ServiceContext", () => {
  for (const transition of ["setSession", "signOut then setSession"] as const) {
    test(`${transition} never dispatches an event from the old session`, async () => {
      let releaseOld!: () => void;
      let enterOld!: () => void;
      const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
      const entered = new Promise<void>((resolve) => { enterOld = resolve; });
      let opens = 0;
      const session = {
        delegationHeader: { Authorization: INVOCATION },
        delegationCid: "c",
        spaceId: "space-123",
        verificationMethod: "did:key:t",
        jwk: {},
      };
      const context = new ServiceContext({
        hosts: ["https://node.tinycloud.xyz"],
        session,
        invoke: () => ({ Authorization: INVOCATION }),
        fetch: async (requestUrl) => {
          if (requestUrl.includes("/hooks/tickets")) return new Response('{"ticket":"t"}');
          opens += 1;
          if (opens === 1) {
            return new Response(new ReadableStream<Uint8Array>({
              async pull(controller) {
                enterOld();
                await oldGate;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...JSON.parse(EVENT), id: "old-session-event" })}\n\n`));
                controller.close();
              },
            }), { status: 200 });
          }
          return new Response(`data: ${JSON.stringify({ ...JSON.parse(EVENT), id: "new-session-event" })}\n\n`);
        },
      });
      const service = new HooksService({ streamRetry: { delay: () => 0, wait: () => turn() } });
      context.registerService("hooks", service);
      initialize(service, context);
      const oldIterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
      const oldPending = oldIterator.next();
      await entered;
      if (transition === "signOut then setSession") service.onSignOut();
      context.setSession({ ...session, delegationCid: "new-session" });
      const nextIterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
      const fresh = await firstEvent(nextIterator);
      expect(fresh?.v?.value).toMatchObject({ id: "new-session-event" });
      releaseOld();
      const oldResult = await oldPending;
      expect(oldResult.value?.id).not.toBe("old-session-event");
      await oldIterator.return?.();
      await nextIterator.return?.();
    });
  }
});

test("a one-shot abortSignal getter failure is retried before backoff", async () => {
  const base = harness([
    FAULTS["open 503"],
    { seam: "wait", act: () => new Promise<void>(() => {}) },
  ]);
  let reads = 0;
  const context = {
    ...base.context,
    get abortSignal() {
      reads += 1;
      if (reads === 1) throw new Error("first abortSignal read");
      return base.context.abortSignal;
    },
  } as IServiceContext;
  const service = new HooksService({ streamRetry: { delay: () => 30_000 } });
  initialize(service, context);
  const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
  const pending = iterator.next();
  for (let i = 0; i < 30; i += 1) await turn();
  base.contextAbort.abort();
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(reads).toBeGreaterThanOrEqual(2);
});

describe("real ServiceContext telemetry ownership", () => {
  test("terminal error reporting is frozen and re-entrant", async () => {
    const session = {
      delegationHeader: { Authorization: INVOCATION },
      delegationCid: "c",
      spaceId: "space-123",
      verificationMethod: "did:key:t",
      jwk: {},
    };
    let mints = 0;
    const context = new ServiceContext({
      hosts: ["https://node.tinycloud.xyz"],
      session,
      invoke: () => ({ Authorization: INVOCATION }),
      fetch: async (url) => {
        if (url.includes("/hooks/tickets")) {
          mints += 1;
          if (mints === 1) return new Response("forbidden", { status: 403 });
          return new Response('{"ticket":"t"}');
        }
        return new Response(`data: ${EVENT}\n\n`);
      },
    });
    const service = new HooksService();
    context.registerService("hooks", service);
    initialize(service, context);
    let reentrant: AsyncIterator<HookEvent> | undefined;
    let reentrantNext: Promise<IteratorResult<HookEvent>> | undefined;
    context.on("service.error", (data) => {
      if (data === null || typeof data !== "object" || !("error" in data)) return;
      const error = data.error;
      if (error === null || typeof error !== "object") throw new Error("telemetry error missing");
      expect(Object.isFrozen(error)).toBe(true);
      if ("meta" in error && error.meta && typeof error.meta === "object") expect(Object.isFrozen(error.meta)).toBe(true);
      reentrant = service.subscribe([{ space: "space-123", service: "kv", abilities: ["tinycloud.kv/put"] }])[Symbol.asyncIterator]();
      reentrantNext = reentrant.next();
    });
    const first = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await firstEvent(first))?.e).toMatchObject({ meta: { status: 403 } });
    expect((await reentrantNext)?.value.id).toBe("evt-1");
    expect(mints).toBe(2);
    await reentrant?.return?.();
  });
});

describe("healthy-stream reset", () => {
  test("an event resets retry streak and a quiet five-second stream resets it again", async () => {
    const delays: number[] = [];
    const eventBytes = new TextEncoder().encode(`data: ${EVENT}\n\n`);
    let opens = 0;
    let closeQuietStream!: () => void;
    const quietStream = new Promise<void>((resolve) => { closeQuietStream = resolve; });
    const context: IServiceContext = {
      session: { delegationHeader: { Authorization: INVOCATION }, delegationCid: "c", spaceId: "space-123", verificationMethod: "did:key:t", jwk: {} },
      isAuthenticated: true,
      invoke: () => ({ Authorization: INVOCATION }),
      invokeAny: undefined,
      hosts: ["https://node.tinycloud.xyz"],
      getService: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
      abortSignal: new AbortController().signal,
      retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
      fetch: async (u) => {
        if (u.includes("/hooks/tickets")) return new Response('{"ticket":"t"}');
        opens += 1;
        if (opens === 1) return new Response("", { status: 200 });
        if (opens === 2) return new Response("down", { status: 503 });
        if (opens === 3) return new Response("expired", { status: 401 });
        if (opens === 4) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(eventBytes);
              void quietStream.then(() => controller.close());
            },
          }), { status: 200 });
        }
        return new Response(`data: ${EVENT}\n\n`, { status: 200 });
      },
    };
    const service = new HooksService({
      streamRetry: {
        delay: (attempt) => { delays.push(attempt); return 0; },
        wait: async () => undefined,
      },
    });
    initialize(service, context);
    const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe("evt-1");
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    closeQuietStream();
    for (let i = 0; i < 100 && delays.length < 4; i += 1) await turn();
    expect(delays.slice(0, 4)).toEqual([1, 2, 3, 1]);
    service.onSignOut();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  }, 10_000);
});

describe("default backoff bounds", () => {
  test("default retry waits stay within the jittered 250 ms half-cap and 30 s cap", async () => {
    const waits: number[] = [];
    let opens = 0;
    let firstAttempt!: () => void;
    const opened = new Promise<void>((resolve) => { firstAttempt = resolve; });
    const context: IServiceContext = {
      session: { delegationHeader: { Authorization: INVOCATION }, delegationCid: "c", spaceId: "space-123", verificationMethod: "did:key:t", jwk: {} },
      isAuthenticated: true,
      invoke: () => ({ Authorization: INVOCATION }),
      invokeAny: undefined,
      hosts: ["https://node.tinycloud.xyz"],
      getService: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
      abortSignal: new AbortController().signal,
      retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
      fetch: async (u) => {
        if (u.includes("/hooks/tickets")) return new Response('{"ticket":"t"}');
        opens += 1;
        if (opens === 1) {
          firstAttempt();
          return new Response("down", { status: 503 });
        }
        return new Response("down", { status: 503 });
      },
    };
    const originalSetTimeout = globalThis.setTimeout;
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
      if (typeof delay === "number" && delay > 0) waits.push(delay);
      return originalSetTimeout(callback, 0);
    }) as typeof setTimeout;
    const service = new HooksService();
    try {
      initialize(service, context);
      const iterator = service.subscribe([{ space: "space-123", service: "kv" }])[Symbol.asyncIterator]();
      const pending = iterator.next();
      for (let i = 0; i < 100 && waits.length < 10; i += 1) {
        await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
      }
      expect(waits).toHaveLength(10);
      const caps = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
      waits.forEach((delay, index) => {
        expect(delay).toBeGreaterThanOrEqual(caps[index]! / 2);
        expect(delay).toBeLessThanOrEqual(caps[index]!);
      });
      expect(waits[7]).toBe(22_500);
      expect(waits[9]).toBe(22_500);
      service.onSignOut();
      await pending;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      Math.random = originalRandom;
    }
  });
});

describe("published child runtimes", () => {
  test("Node 22, Node 20, and configured extra runtimes recover over HTTP and naturally exit after default backoff cancellation", async () => {
    const dist = resolve(import.meta.dir, "../../dist/index.js");
    if (!existsSync(dist)) throw new Error(`missing built sdk-services dist: ${dist}`);
    // `node` is required; TC_HOOKS_EXTRA_NODE_RUNTIMES adds colon-separated absolute node binary paths.
    const runtimes = ["node", ...(process.env.TC_HOOKS_EXTRA_NODE_RUNTIMES ?? "").split(":").filter(Boolean)];
    for (const runtime of runtimes.slice(1)) {
      if (!existsSync(runtime)) throw new Error(`missing extra Node runtime: ${runtime}`);
    }
    const script = `
      import { createServer } from "node:http";
      import { HooksService } from ${JSON.stringify(`file://${dist}`)};
      const scenario = process.env.TC_SCENARIO;
      const session = {delegationHeader:{},delegationCid:"c",spaceId:"s",verificationMethod:"v",jwk:{}};
      const payload = id => JSON.stringify({id,space:"s",service:"kv",ability:"a",path:"p",actor:"d",epoch:"e",eventIndex:1,timestamp:"t"});
      let mints=0, opens=0, injected=false;
      const server = createServer((req,res) => {
        if(req.url === "/hooks/tickets") { mints++; res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ticket:"t"+mints})); return; }
        if(req.url.startsWith("/hooks/events")) {
          opens++;
          if(scenario === "401" && opens === 1) { res.writeHead(401); res.end("expired"); return; }
          if(scenario === "wait" && opens === 1) { res.writeHead(503); res.end("retry"); return; }
          res.writeHead(200,{"content-type":"text/event-stream"});
          res.end("event: hook\\nid: evt-"+scenario+"\\ndata: "+payload("evt-"+scenario)+"\\n\\n");
          return;
        }
        res.writeHead(404); res.end();
      });
      await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
      const host="http://127.0.0.1:"+server.address().port;
      const nativeFetch=globalThis.fetch;
      const service=new HooksService({host,streamRetry:scenario==="wait"?{wait(){throw new Error("wait failed")}}:undefined});
      let signalReads=0;
      const context={session,isAuthenticated:true,invoke:()=>({}),invokeAny:undefined,
        fetch:async(url,init)=>{
          if(scenario==="name" && String(url).includes("/hooks/events") && !injected) {
            injected=true; const error={}; Object.defineProperty(error,"name",{get(){throw new Error("hostile name")} }); throw error;
          }
          return nativeFetch(url,init);
        },
        hosts:[host],getService:()=>undefined,emit:()=>undefined,on:()=>()=>undefined,
        get abortSignal(){signalReads++; if(scenario==="abortSignal" && signalReads===1) throw new Error("hostile signal"); return new AbortController().signal;},
        retryPolicy:{maxAttempts:1,backoff:"exponential",baseDelayMs:1,maxDelayMs:1,retryableErrors:[]}};
      service.initialize(context);
      const iterator=service.subscribe([{space:"s",service:"kv",abilities:["a"]}])[Symbol.asyncIterator]();
      const received=await iterator.next();
      if(received.done || received.value.id!=="evt-"+scenario) throw new Error("event id missing");
      await iterator.return();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      console.log("EVENT "+received.value.id);
    `;
    for (const runtime of runtimes) {
      for (const scenario of ["401", "name", "wait", "abortSignal"]) {
        const child = Bun.spawn(
          [runtime, "--unhandled-rejections=throw", "--input-type=module", "--eval", script],
          { env: { ...process.env, TC_SCENARIO: scenario }, stdout: "pipe", stderr: "pipe" },
        );
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toContain(`EVENT evt-${scenario}`);
      }
    }
    const naturalExit = `
      import {createServer} from "node:http";
      import {HooksService} from ${JSON.stringify(`file://${dist}`)};
      const session={delegationHeader:{},delegationCid:"c",spaceId:"s",verificationMethod:"v",jwk:{}};
      let opened,delay;
      const openedPromise=new Promise(resolve=>opened=resolve);
      const delayPromise=new Promise(resolve=>delay=resolve);
      const server=createServer((req,res)=>{
        if(req.url==="/hooks/tickets"){res.writeHead(200,{"content-type":"application/json"});res.end('{"ticket":"t"}');return;}
        if(req.url.startsWith("/hooks/events")){res.writeHead(503);res.end();opened();return;}
        res.writeHead(404);res.end();
      });
      await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
      const host="http://127.0.0.1:"+server.address().port;
      const service=new HooksService({host,streamRetry:{delay(){delay();return 30000;}}});
      service.initialize({session,isAuthenticated:true,invoke:()=>({}),invokeAny:undefined,fetch,hosts:[host],getService:()=>undefined,emit:()=>undefined,on:()=>()=>undefined,abortSignal:new AbortController().signal,retryPolicy:{maxAttempts:1,backoff:"exponential",baseDelayMs:1,maxDelayMs:1,retryableErrors:[]}});
      const iterator=service.subscribe([{space:"s",service:"kv"}])[Symbol.asyncIterator]();
      const pending=iterator.next();
      await openedPromise;
      await delayPromise;
      service.onSignOut();
      await pending;
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
      console.log("NATURAL_EXIT");
    `;
    for (const runtime of runtimes) {
      const child = Bun.spawn(
        [runtime, "--unhandled-rejections=throw", "--input-type=module", "--eval", naturalExit],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("NATURAL_EXIT");
    }
  }, 30000);
});
