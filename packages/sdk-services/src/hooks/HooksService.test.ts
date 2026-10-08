import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HooksService } from "./HooksService";
import { ErrorCodes, type FetchResponse, type IServiceContext } from "../types";
import type { HookSubscription, HookWebhookRegistration } from "./types";

function createContext(
  fetchImpl: IServiceContext["fetch"],
  overrides: Partial<IServiceContext> = {},
): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "space-123",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: () => ({}) as never,
    invokeAny: undefined,
    fetch: fetchImpl,
    hosts: ["https://node.tinycloud.xyz"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: [],
    },
    ...overrides,
  };
}

describe("HooksService.register", () => {
  test("rejects missing or empty secrets before issuing a request", async () => {
    let fetchCalls = 0;
    const service = new HooksService({ host: "https://node.tinycloud.xyz" });
    service.initialize(
      createContext(async () => {
        fetchCalls += 1;
        throw new Error("unexpected fetch");
      }),
    );

    const webhook = {
      space: "space-123",
      service: "kv",
      pathPrefix: "hooks",
      abilities: ["tinycloud.kv/put"],
      callbackUrl: "https://example.com/hooks",
    } as Omit<HookWebhookRegistration, "secret">;

    const invalidSecrets = [undefined, "", "   "];
    for (const secret of invalidSecrets) {
      const result = await service.register({
        ...webhook,
        secret: secret as unknown as string,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
        expect(result.error.message).toContain("Webhook secret is required");
      }
    }

    expect(fetchCalls).toBe(0);
  });
});

describe("HooksService error responses", () => {
  test.each([401, 403, 502])("list %i keeps the status typed and in the message", async (status) => {
    const service = new HooksService({ host: "https://node.tinycloud.xyz" });
    service.initialize(
      createContext(async () => new Response("hook ticket expired", { status })),
    );

    const result = await service.list();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.meta?.status).toBe(status);
    expect(result.error.message).toBe(`failed to list webhooks: ${status} hook ticket expired`);
  });
});

const SUBSCRIPTION: HookSubscription = {
  space: "space-123",
  service: "kv",
  abilities: ["tinycloud.kv/put"],
};

const HOOK_EVENT = {
  type: "write",
  id: "evt-1",
  space: "space-123",
  service: "kv",
  ability: "tinycloud.kv/put",
  path: "hooks/a",
  actor: "did:key:actor",
  epoch: "epoch-1",
  eventIndex: 1,
  timestamp: "2026-01-01T00:00:00Z",
};

function sseResponse(eventId: string, path = "hooks/a"): Response {
  const body = `event: hook\nid: ${eventId}\ndata: ${JSON.stringify({ ...HOOK_EVENT, id: eventId, path })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Drain pending promise chains without sleeping real time. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Node-20-safe `Promise.withResolvers` (not in engines >=20). */
function newPromiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settleRefreshChain(): Promise<void> {
  // A retry cycle costs several macrotask turns (mint + open fakes, the
  // SSE drain, the retry wait, and the mandatory event-loop yield after a
  // custom wait). Sixty turns cover several cycles so detached promises —
  for (let i = 0; i < 60; i += 1) {
    await flushMicrotasks();
  }
}

function watchUnhandledRejections(): {
  rejections: unknown[];
  stop: () => void;
} {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    rejections,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

describe("HooksService shared stream recovery", () => {
  test("a 401 from /hooks/events re-mints and recovers instead of crashing", async () => {
    const { rejections, stop } = watchUnhandledRejections();

    const mints: unknown[] = [];
    const openedTickets: string[] = [];
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        const ticket = `ticket-${mints.length + 1}`;
        mints.push(ticket);
        return new Response(
          JSON.stringify({ ticket, expiresAt: "2026-01-01T01:00:00Z" }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        const ticket = new URL(url).searchParams.get("ticket")!;
        openedTickets.push(ticket);
        if (openedTickets.length === 1) {
          // The rotated/expired ticket the node rejects once (TC-820).
          return new Response("invalid ticket signature", {
            status: 401,
            statusText: "Unauthorized",
          }) as FetchResponse;
        }
        return sseResponse("evt-1") as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const delays: number[] = [];
    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        wait: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });
    service.initialize(createContext(fetchImpl));

    try {
      const iterator = service.subscribe([{ ...SUBSCRIPTION }])[
        Symbol.asyncIterator
      ]();
      const first = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value?.id).toBe("evt-1");
      // The rejected ticket was not reused: a second mint ran and its ticket
      // opened the second stream.
      expect(mints).toEqual(["ticket-1", "ticket-2"]);
      expect(openedTickets).toEqual(["ticket-1", "ticket-2"]);
      expect(delays.length).toBe(1);

      await iterator.return?.();
      await settleRefreshChain();
      expect(rejections).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a 503 from /hooks/events retries with injected backoff and recovers", async () => {
    const { rejections, stop } = watchUnhandledRejections();

    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        return new Response(
          JSON.stringify({
            ticket: `ticket-${opens}`,
            expiresAt: "2026-01-01T01:00:00Z",
          }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        if (opens === 1) {
          return new Response("node restarting", {
            status: 503,
            statusText: "Service Unavailable",
          }) as FetchResponse;
        }
        return sseResponse("evt-503") as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const delays: Array<{ delayMs: number; attempt: number }> = [];
    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        delay: (attempt) => attempt * 5,
        wait: async (delayMs, attempt) => {
          delays.push({ delayMs, attempt });
        },
      },
    });
    service.initialize(createContext(fetchImpl));

    try {
      const iterator = service.subscribe([{ ...SUBSCRIPTION }])[
        Symbol.asyncIterator
      ]();
      const first = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value?.id).toBe("evt-503");
      expect(opens).toBe(2);
      expect(delays).toEqual([{ delayMs: 5, attempt: 1 }]);

      await iterator.return?.();
      await settleRefreshChain();
      expect(rejections).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a 403 ticket mint refusal fails the iterator and stops retrying", async () => {
    const { rejections, stop } = watchUnhandledRejections();

    let mints = 0;
    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        mints += 1;
        return new Response("no hooks authority", {
          status: 403,
          statusText: "Forbidden",
        }) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: { wait: async () => undefined },
    });
    service.initialize(createContext(fetchImpl));

    try {
      const iterator = service.subscribe([{ ...SUBSCRIPTION }])[
        Symbol.asyncIterator
      ]();

      let thrown: unknown;
      try {
        await iterator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      const serviceError = thrown as {
        meta?: { status?: number };
        message?: string;
      };
      expect(serviceError.meta?.status).toBe(403);
      expect(serviceError.message).toContain("failed to mint hook ticket");

      // The thrown error removes the subscriber; with the signature marked
      // terminal the refresh chain makes no further mint/open attempts.
      await settleRefreshChain();
      expect(mints).toBe(1);
      expect(opens).toBe(0);
      expect(rejections).toEqual([]);
    } finally {
      stop();
    }
  });

  test("retries stop once the last subscriber unsubscribes", async () => {
    let mints = 0;
    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        mints += 1;
        return new Response(
          JSON.stringify({
            ticket: `ticket-${mints}`,
            expiresAt: "2026-01-01T01:00:00Z",
          }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        return new Response("still down", {
          status: 503,
          statusText: "Service Unavailable",
        }) as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    // The injected wait parks until the stream aborts, so "in backoff" is an
    // awaited signal, not a duration guess. With the subscriber gone, the
    // refresh chain must settle without another mint or open.
    const { promise: backoff, resolve: backoffEntered } =
      newPromiseWithResolvers<void>();
    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        wait: (_delayMs, _attempt, signal) => {
          backoffEntered();
          return new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          });
        },
      },
    });
    service.initialize(createContext(fetchImpl));

    const unsubscribe = new AbortController();
    const iterator = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();

    await backoff;
    await settleRefreshChain();
    expect(mints).toBe(1);
    expect(opens).toBe(1);

    // Unsubscribing aborts the parked backoff; the refresh chain settles
    // with no subscribers and nothing else is minted or opened.
    unsubscribe.abort();
    await pending;
    await settleRefreshChain();

    expect(mints).toBe(1);
    expect(opens).toBe(1);
  });

  test("a 401 stream failure does not kill a real Node process", async () => {
    // Spawns plain `node` (default --unhandled-rejections=throw) against the
    // built dist, matching the original TC-820 reproduction. Missing dist
    // is a build error, not a pass.
    const dist = resolve(import.meta.dir, "../../dist/index.js");
    if (!existsSync(dist)) {
      throw new Error(
        "sdk-services dist is not built: run `bun run build` in packages/sdk-services first",
      );
    }

    const script = `
      import { HooksService } from ${JSON.stringify(`file://${dist}`)};
      const service = new HooksService({
        host: "https://node.tinycloud.xyz",
        streamRetry: { wait: async () => {} },
      });
      let mints = 0;
      let opens = 0;
      service.initialize({
        session: {
          delegationHeader: { Authorization: "Bearer test" },
          delegationCid: "bafybeitest",
          spaceId: "space-123",
          verificationMethod: "did:key:test",
          jwk: {},
        },
        isAuthenticated: true,
        invoke: () => ({}),
        invokeAny: undefined,
        fetch: async (url) => {
          // Yield one I/O turn per call: a real fetch does I/O, which lets
          // the microtask queue drain — that drain is when Node dispatches
          // unhandledRejection and --unhandled-rejections=throw kills the
          // process. A promise that resolves inline would starve the loop
          // and mask the crash this test is for.
          await new Promise((r) => setImmediate(r));
          if (url.includes("/hooks/tickets")) {
            mints += 1;
            return new Response(JSON.stringify({
              ticket: "ticket-" + mints,
              expiresAt: "2026-01-01T01:00:00Z",
            }), { status: 200 });
          }
          if (url.includes("/hooks/events")) {
            opens += 1;
            if (opens === 1) {
              return new Response("invalid ticket signature", { status: 401 });
            }
            const event = JSON.stringify({
              id: "evt-node",
              space: "space-123",
              service: "kv",
              ability: "tinycloud.kv/put",
              path: "hooks/a",
              actor: "did:key:actor",
              epoch: "epoch-1",
              eventIndex: 1,
              timestamp: "2026-01-01T00:00:00Z",
            });
            return new Response(
              \`event: hook\\nid: evt-node\\ndata: \${event}\\n\\n\`,
              {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              },
            );
          }
          return new Response("not found", { status: 404 });
        },
        hosts: ["https://node.tinycloud.xyz"],
        getService: () => undefined,
        emit: () => undefined,
        on: () => () => undefined,
        abortSignal: new AbortController().signal,
        retryPolicy: {
          maxAttempts: 3,
          backoff: "exponential",
          baseDelayMs: 1000,
          maxDelayMs: 10000,
          retryableErrors: [],
        },
      });
      const it = service.subscribe([
        { space: "space-123", service: "kv", abilities: ["tinycloud.kv/put"] },
      ])[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done || first.value?.id !== "evt-node") {
        console.error("stream did not recover");
        process.exit(2);
      }
      await it.return?.();
      // Give the event loop turns so a leaked unhandled rejection would fire.
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      console.log("OK mints=" + mints + " opens=" + opens);
      process.exit(0);
    `;

    const run = async (nodeBin: string) => {
      const proc = Bun.spawn(
        [
          nodeBin,
          "--unhandled-rejections=throw",
          "--input-type=module",
          "--eval",
          script,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    };

    const primary = await run("node");
    expect(primary.stderr).not.toContain("ERR_UNHANDLED_REJECTION");
    expect(primary.stderr).toBe("");
    expect(primary.stdout).toContain("OK mints=2 opens=2");
    expect(primary.exitCode).toBe(0);

    // Engines claim Node >=20; repeat under Node 20 when a binary exists so
    // the published runtime floor is exercised too.
    const node20 = ["/tmp/node-v20.19.4-linux-x64/bin/node"].find((candidate) =>
      existsSync(candidate),
    );
    if (node20) {
      const second = await run(node20);
      expect(second.stderr).not.toContain("ERR_UNHANDLED_REJECTION");
      expect(second.stderr).toBe("");
      expect(second.stdout).toContain("OK mints=2 opens=2");
      expect(second.exitCode).toBe(0);
    }
  }, 15000);
  test("an empty 200 stream backs off instead of reopening in a hot loop", async () => {
    // A clean EOF used to resolve the task and reopen instantly — ~1500
    // opens in 250 ms. Every reopen must now pass through the backoff.
    let mints = 0;
    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      if (url.includes("/hooks/tickets")) {
        mints += 1;
        return new Response(
          JSON.stringify({
            ticket: `ticket-${mints}`,
            expiresAt: "2026-01-01T01:00:00Z",
          }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        // A stream that opens and immediately ends.
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }) as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const attempts: number[] = [];
    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        delay: (attempt) => attempt * 100,
        wait: async (_delayMs, attempt) => {
          attempts.push(attempt);
        },
      },
    });
    service.initialize(createContext(fetchImpl));

    const unsubscribe = new AbortController();
    const iterator = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();

    await settleRefreshChain();
    // Several reopen cycles ran; each one paid a backoff first.
    expect(opens).toBeGreaterThan(2);
    expect(attempts).toEqual(
      Array.from({ length: attempts.length }, (_v, i) => i + 1),
    );
    // The stream opened once per completed backoff — no run resolved its
    // way past the wait.
    expect(opens).toBeLessThanOrEqual(attempts.length + 1);

    unsubscribe.abort();
    await pending;
    await settleRefreshChain();

    const opensAtStop = opens;
    const attemptsAtStop = attempts.length;
    await settleRefreshChain();
    expect(opens).toBe(opensAtStop);
    expect(attempts.length).toBe(attemptsAtStop);
  });

  test("an aborted service context stops the stream instead of retrying", async () => {
    // With the context aborted but still authenticated, every fetch rejects
    // AbortError. The pre-fix code swallowed it and rescheduled forever.
    const contextAbort = new AbortController();
    contextAbort.abort();

    let fetches = 0;
    let waits = 0;
    const fetchImpl: IServiceContext["fetch"] = async () => {
      fetches += 1;
      return new Response("gone", { status: 503 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        wait: async () => {
          waits += 1;
        },
      },
    });
    service.initialize(
      createContext(fetchImpl, { abortSignal: contextAbort.signal }),
    );

    const iterator = service.subscribe([{ ...SUBSCRIPTION }])[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();

    await settleRefreshChain();
    expect(fetches).toBe(0);
    expect(waits).toBe(0);

    // The iterator just sits; the stream is dead. Clean up by aborting the
    // subscription itself.
    const unsubscribe = new AbortController();
    unsubscribe.abort();
    void pending;
    void iterator;
  });

  test("sign-out cancels a parked backoff and stops retrying", async () => {
    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        return new Response(
          JSON.stringify({ ticket: "t1", expiresAt: "2026-01-01T01:00:00Z" }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        return new Response("down", { status: 503 }) as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const { promise: backoff, resolve: backoffEntered } =
      newPromiseWithResolvers<void>();
    const signals: AbortSignal[] = [];
    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        wait: (_delayMs, _attempt, signal) => {
          signals.push(signal);
          backoffEntered();
          return new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    });
    service.initialize(createContext(fetchImpl));

    const iterator = service.subscribe([{ ...SUBSCRIPTION }])[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();

    await backoff;
    expect(signals.length).toBe(1);
    expect(signals[0]!.aborted).toBe(false);

    service.onSignOut();

    // The sign-out aborted the lifecycle signal the wait was parked on.
    await settleRefreshChain();
    expect(signals[0]!.aborted).toBe(true);
    expect(opens).toBe(1);

    void pending;
    void iterator;
  });

  test("a terminal mint refusal clears when subscribers leave", async () => {
    // After the 403 throws every subscriber away, a fresh subscription to
    // the same scope must mint again — not replay the cached refusal.
    let mints = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        mints += 1;
        if (mints === 1) {
          return new Response("no hooks authority", {
            status: 403,
            statusText: "Forbidden",
          }) as FetchResponse;
        }
        return new Response(
          JSON.stringify({
            ticket: `ticket-${mints}`,
            expiresAt: "2026-01-01T01:00:00Z",
          }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        return sseResponse("evt-retry") as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: { wait: async () => undefined },
    });
    service.initialize(createContext(fetchImpl));

    const first = service.subscribe([{ ...SUBSCRIPTION }])[
      Symbol.asyncIterator
    ]();
    let thrown: unknown;
    try {
      await first.next();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { meta?: { status?: number } }).meta?.status).toBe(403);
    await settleRefreshChain();
    expect(mints).toBe(1);

    const unsubscribe = new AbortController();
    const second = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const event = await second.next();
    expect(event.value?.id).toBe("evt-retry");
    expect(mints).toBe(2);

    unsubscribe.abort();
    await settleRefreshChain();
  });

  test("a session change clears a terminal mint refusal", async () => {
    let mints = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        mints += 1;
        if (mints === 1) {
          return new Response("no hooks authority", {
            status: 403,
            statusText: "Forbidden",
          }) as FetchResponse;
        }
        return new Response(
          JSON.stringify({
            ticket: `ticket-${mints}`,
            expiresAt: "2026-01-01T01:00:00Z",
          }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        return sseResponse("evt-session") as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: { wait: async () => undefined },
    });
    service.initialize(createContext(fetchImpl));

    const first = service.subscribe([{ ...SUBSCRIPTION }])[
      Symbol.asyncIterator
    ]();
    let thrown: unknown;
    try {
      await first.next();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { meta?: { status?: number } }).meta?.status).toBe(403);
    await settleRefreshChain();

    // Session refresh: new credentials get a fresh mint attempt.
    service.onSessionChange(null);

    const unsubscribe = new AbortController();
    const second = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const event = await second.next();
    expect(event.value?.id).toBe("evt-session");
    expect(mints).toBe(2);

    unsubscribe.abort();
    await settleRefreshChain();
  });

  test("a stale mint refusal is discarded, not broadcast to new subscribers", async () => {
    // Subscriber B joins while A's mint is in flight, changing the
    // subscription signature. A's mint is superseded; when it finally
    // answers 403 anyway, that refusal belongs to a dead run and must not
    // fail A or B.
    let mints = 0;
    let opens = 0;
    const { promise: releaseMint, resolve: releaseMintGate } =
      newPromiseWithResolvers<void>();
    const fetchImpl: IServiceContext["fetch"] = async (url, init) => {
      if (url.includes("/hooks/tickets")) {
        mints += 1;
        if (mints === 1) {
          // Parks through the abort, then answers the refusal late — like
          // 403 headers arriving before the body is drained.
          await releaseMint;
          return new Response("no hooks authority", {
            status: 403,
            statusText: "Forbidden",
          }) as FetchResponse;
        }
        return new Response(
          JSON.stringify({
            ticket: `ticket-${mints}`,
            expiresAt: "2026-01-01T01:00:00Z",
          }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        return sseResponse("evt-merged", "other/x") as FetchResponse;
      }
      void init;
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: { wait: async () => undefined },
    });
    service.initialize(
      createContext(fetchImpl, {
        // The merged A+B scope needs two invocation entries — without
        // invokeAny the runtime reports "multi-scope" and mints forever.
        invokeAny: () => ({ Authorization: "Bearer test" }),
      }),
    );

    const subscriptionB: HookSubscription = {
      space: "space-123",
      service: "kv",
      pathPrefix: "other",
      abilities: ["tinycloud.kv/put"],
    };

    const unsubscribe = new AbortController();
    const itA = service.subscribe([{ ...SUBSCRIPTION }], {
      signal: unsubscribe.signal,
    })[Symbol.asyncIterator]();
    const pendingA = itA.next();

    // Let A's refresh collect its state and park inside mint1 — only then
    // is B's scope change a real signature change that supersedes mint1.
    await flushMicrotasks();
    await flushMicrotasks();

    const itB = service.subscribe([subscriptionB], {
      signal: unsubscribe.signal,
    })[Symbol.asyncIterator]();
    const pendingB = itB.next();

    // Let the signature change supersede the parked mint, then deliver its
    // late refusal.
    await settleRefreshChain();
    releaseMintGate();

    const resultA = await pendingA;
    const resultB = await pendingB;
    expect(resultA.done).toBe(false);
    expect(resultB.done).toBe(false);
    expect(opens).toBe(1);
    expect(mints).toBe(2);

    unsubscribe.abort();
    await settleRefreshChain();
  });

  test("stream-open errors never leak ticket material in any encoding", async () => {
    const emitted: unknown[] = [];
    const ticket = "tick et+/=";
    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        return new Response(
          JSON.stringify({ ticket, expiresAt: "2026-01-01T01:00:00Z" }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        // The node echoes the request URL in the refusal body — the ticket
        // appears raw and percent-encoded.
        return new Response(
          `refused GET /hooks/events?ticket=${encodeURIComponent(ticket)} and ${ticket}`,
          { status: 401, statusText: "Unauthorized" },
        ) as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: { wait: async () => undefined },
    });
    service.initialize(
      createContext(fetchImpl, {
        emit: (event, data) => {
          if (event === "service.error") {
            emitted.push(data);
          }
        },
      }),
    );

    const unsubscribe = new AbortController();
    const iterator = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();

    await settleRefreshChain();
    expect(opens).toBeGreaterThan(0);
    expect(emitted.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(emitted);
    const urlEncoded = encodeURIComponent(ticket);
    const formEncoded = new URLSearchParams({ ticket })
      .toString()
      .slice("ticket=".length);
    for (const form of [ticket, urlEncoded, formEncoded]) {
      expect(serialized).not.toContain(form);
    }
    expect(serialized).toContain("[redacted]");

    unsubscribe.abort();
    await pending;
  });

  test("a transport rejection on the stream is redacted before telemetry", async () => {
    // Round-2 review: redaction only covered non-OK HTTP responses, so a
    // fetch() that rejects with the request URL leaked the ticket into
    // service.error in message, cause.message and stack.
    const emitted: unknown[] = [];
    const ticket = "tr ans+/=";
    let opens = 0;
    const streamUrl = `https://node.tinycloud.xyz/hooks/events?ticket=${ticket}`;
    const fetchImpl: IServiceContext["fetch"] = async (url) => {
      if (url.includes("/hooks/tickets")) {
        return new Response(
          JSON.stringify({ ticket, expiresAt: "2026-01-01T01:00:00Z" }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        const cause = new Error(
          `read ECONNRESET reading ${encodeURIComponent(streamUrl)}`,
        );
        cause.stack = `Error: socket died at ${streamUrl}`;
        const transport = new Error(
          `request to ${streamUrl} failed, reason: socket hang up`,
        );
        transport.cause = cause;
        throw transport;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: { wait: async () => undefined },
    });
    service.initialize(
      createContext(fetchImpl, {
        emit: (event, data) => {
          if (event === "service.error") {
            emitted.push(data);
          }
        },
      }),
    );

    const unsubscribe = new AbortController();
    const iterator = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();

    await settleRefreshChain();
    expect(opens).toBeGreaterThan(0);
    expect(emitted.length).toBeGreaterThan(0);

    // The emitted error is a fresh ServiceError, and no reachable string —
    // message, cause chain, stack, meta — contains the ticket in any
    // encoding. JSON.stringify exposes cause.stack/message for real Errors.
    const first = emitted[0] as Record<string, unknown> & {
      cause?: { message?: string; stack?: string };
    };
    expect(first.service).toBe("hooks");
    const serialized = JSON.stringify(emitted, (_key, value) =>
      value instanceof Error
        ? { message: value.message, stack: value.stack, cause: value.cause }
        : value,
    );
    const urlEncoded = encodeURIComponent(ticket);
    const formEncoded = new URLSearchParams({ ticket })
      .toString()
      .slice("ticket=".length);
    for (const form of [ticket, urlEncoded, formEncoded]) {
      expect(serialized).not.toContain(form);
    }

    unsubscribe.abort();
    await pending;
  });

  test("a throwing custom wait still yields the event loop", async () => {
    // A custom wait that throws used to skip the anti-starvation yield:
    // with an instantly failing fetch, thousands of mints ran before an
    // already-scheduled setTimeout(…, 0) fired. The yield now runs in a
    // finally, so every attempt pays exactly one event-loop turn.
    let opens = 0;
    const fetchImpl: IServiceContext["fetch"] = async (url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      if (url.includes("/hooks/tickets")) {
        return new Response(
          JSON.stringify({ ticket: "t", expiresAt: "x" }),
          { status: 200 },
        ) as FetchResponse;
      }
      if (url.includes("/hooks/events")) {
        opens += 1;
        return new Response("down", {
          status: 500,
          statusText: "Internal Server Error",
        }) as FetchResponse;
      }
      return new Response("not found", { status: 404 }) as FetchResponse;
    };

    const service = new HooksService({
      host: "https://node.tinycloud.xyz",
      streamRetry: {
        wait: () => {
          throw new Error("wait hook threw synchronously");
        },
      },
    });
    service.initialize(createContext(fetchImpl));

    const { promise: timerFired, resolve: fireTimer } =
      newPromiseWithResolvers<number>();
    // A real zero-delay timer scheduled before the stream starts: under the
    // old code it starved until the loop ended; now it fires after a handful
    // of attempts.
    setTimeout(() => fireTimer(opens), 0);

    const unsubscribe = new AbortController();
    const iterator = service.subscribe(
      [{ ...SUBSCRIPTION }],
      { signal: unsubscribe.signal },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();

    const opensWhenTimerFired = await timerFired;
    // Without the per-attempt yield this is 0 turns in — the timer never
    // fires while thousands of mints pile up. With it, the timer fires after
    // at most a couple of attempts.
    expect(opensWhenTimerFired).toBeLessThan(10);

    unsubscribe.abort();
    await pending;
    await settleRefreshChain();
  });

  test("no unhandled rejection escapes the detached stream chain", async () => {
    // Round-2 review: a .then(success, failure) pair only covered the run's
    // rejection — a throw inside settle, cleanup, or the reschedule escaped
    // to ERR_UNHANDLED_REJECTION. Three fault injections, each spawned under
    // plain `node --unhandled-rejections=throw` against dist:
    //   hostile-name — fetch rejects with an Error whose `name` getter
    //                  throws, breaking isAbortError during settlement;
    //   throwing-wait — a custom streamRetry.wait throws synchronously;
    //   hostile-abort — context.abortSignal's getter throws once the stream
    //                  task exists, throwing inside .finally's lifecycle
    //                  check during reschedule.
    const dist = resolve(import.meta.dir, "../../dist/index.js");
    if (!existsSync(dist)) {
      throw new Error(
        "sdk-services dist is not built: run `bun run build` in packages/sdk-services first",
      );
    }

    const script = (scenario: string) => `
      import { HooksService } from ${JSON.stringify(`file://${dist}`)};
      const scenario = ${JSON.stringify(scenario)};

      const hostileError = () => {
        const err = new Error("socket hang up");
        Object.defineProperty(err, "name", {
          get() {
            throw new Error("hostile name getter");
          },
        });
        return err;
      };

      let poisoned = false;
      const ctx = {
        session: {
          delegationHeader: { Authorization: "Bearer test" },
          delegationCid: "bafybeitest",
          spaceId: "space-123",
          verificationMethod: "did:key:test",
          jwk: {},
        },
        isAuthenticated: true,
        invoke: () => ({}),
        invokeAny: undefined,
        fetch: async (url, init) => {
          // One I/O turn per call so the microtask queue drains — that is
          // when Node dispatches unhandledRejection.
          await new Promise((r) => setImmediate(r));
          if (init?.signal?.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
          if (url.includes("/hooks/tickets")) {
            return new Response(JSON.stringify({
              ticket: "ticket-1",
              expiresAt: "2026-01-01T01:00:00Z",
            }), { status: 200 });
          }
          if (url.includes("/hooks/events")) {
            poisoned = true;
            if (scenario === "hostile-name") {
              throw hostileError();
            }
            return new Response("down", { status: 500 });
          }
          return new Response("not found", { status: 404 });
        },
        hosts: ["https://node.tinycloud.xyz"],
        getService: () => undefined,
        emit: () => undefined,
        on: () => () => undefined,
        abortSignal: new AbortController().signal,
        retryPolicy: {
          maxAttempts: 3,
          backoff: "exponential",
          baseDelayMs: 1000,
          maxDelayMs: 10000,
          retryableErrors: [],
        },
      };
      if (scenario === "hostile-abort") {
        // Reads after the stream opens throw inside the task's .finally
        // when it checks lifecycleAborted for the reschedule.
        Object.defineProperty(ctx, "abortSignal", {
          get() {
            if (poisoned) {
              throw new Error("poisoned abortSignal getter");
            }
            return new AbortController().signal;
          },
        });
      }

      const service = new HooksService({
        host: "https://node.tinycloud.xyz",
        streamRetry:
          scenario === "throwing-wait"
            ? {
                wait: () => {
                  throw new Error("custom wait exploded");
                },
              }
            : { wait: async () => {} },
      });
      service.initialize(ctx);
      const it = service
        .subscribe([{ space: "space-123", service: "kv" }])
        [Symbol.asyncIterator]();
      const pending = it.next();
      // Several retry cycles: enough for the fault to settle, reschedule,
      // and — if any link rethrew — for Node's unhandledRejection to fire.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      pending.catch(() => undefined);
      console.log("OK " + scenario);
      process.exit(0);
    `;

    const run = async (nodeBin: string, scenario: string) => {
      const proc = Bun.spawn(
        [
          nodeBin,
          "--unhandled-rejections=throw",
          "--input-type=module",
          "--eval",
          script(scenario),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    };

    const scenarios = ["hostile-name", "throwing-wait", "hostile-abort"];
    for (const scenario of scenarios) {
      const result = await run("node", scenario);
      expect(result.stderr).not.toContain("ERR_UNHANDLED_REJECTION");
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`OK ${scenario}`);
      expect(result.exitCode).toBe(0);
    }

    // Engines claim Node >=20; repeat under Node 20 when a binary exists.
    const node20 = ["/tmp/node-v20.19.4-linux-x64/bin/node"].find((candidate) =>
      existsSync(candidate),
    );
    if (node20) {
      for (const scenario of scenarios) {
        const result = await run(node20, scenario);
        expect(result.stderr).not.toContain("ERR_UNHANDLED_REJECTION");
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`OK ${scenario}`);
        expect(result.exitCode).toBe(0);
      }
    }
  }, 30000);
});

