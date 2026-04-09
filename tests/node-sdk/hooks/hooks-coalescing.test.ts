import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";

type HookMetrics = {
  ticketRequests: number;
  streamRequests: number;
  activeStreams: number;
  maxActiveStreams: number;
};

describe("Hooks integration", () => {
  let alice: TinyCloudNode;
  let restoreFetch: (() => void) | undefined;
  let metrics: HookMetrics;

  beforeAll(async () => {
    await checkServerHealth();
    ({ restoreFetch, metrics } = installFetchMetrics());
    alice = createClient("alice-hooks", TEST_KEY);
    await alice.signIn();
  });

  afterAll(() => {
    restoreFetch?.();
  });

  test(
    "coalesces subscriptions into one physical stream per host and invoker",
    async () => {
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();

      const firstSubscription = alice.hooks.subscribe(
        [
          {
            space: alice.spaceId!,
            service: "kv",
            pathPrefix: "hooks-a/",
            abilities: ["tinycloud.kv/put"],
          },
        ],
        { signal: firstAbort.signal }
      )[Symbol.asyncIterator]();

      const firstNext = firstSubscription.next();
      await waitFor(() => metrics.activeStreams === 1);

      const secondSubscription = alice.hooks.subscribe(
        [
          {
            space: alice.spaceId!,
            service: "kv",
            pathPrefix: "hooks-b/",
            abilities: ["tinycloud.kv/put"],
          },
        ],
        { signal: secondAbort.signal }
      )[Symbol.asyncIterator]();

      const secondNext = secondSubscription.next();
      await waitFor(() => metrics.streamRequests >= 2);
      await waitFor(() => metrics.maxActiveStreams === 1);

      firstAbort.abort();
      secondAbort.abort();

      await Promise.allSettled([firstNext, secondNext]);

      expect(metrics.maxActiveStreams).toBe(1);
      expect(metrics.streamRequests).toBe(2);
      expect(metrics.ticketRequests).toBe(2);
    },
    30000
  );
});

function installFetchMetrics(): { metrics: HookMetrics; restoreFetch: () => void } {
  const realFetch = globalThis.fetch.bind(globalThis);
  const metrics: HookMetrics = {
    ticketRequests: 0,
    streamRequests: 0,
    activeStreams: 0,
    maxActiveStreams: 0,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = toUrl(input);
    const response = await realFetch(input, init);

    if (url.pathname === "/hooks/tickets") {
      metrics.ticketRequests += 1;
      return response;
    }

    if (url.pathname === "/hooks/events") {
      metrics.streamRequests += 1;
      return wrapStreamResponse(response, metrics);
    }

    return response;
  }) as typeof globalThis.fetch;

  return {
    metrics,
    restoreFetch: () => {
      globalThis.fetch = realFetch as typeof globalThis.fetch;
    },
  };
}

function wrapStreamResponse(response: Response, metrics: HookMetrics): Response {
  if (!response.body) {
    return response;
  }

  let accounted = false;
  const release = () => {
    if (!accounted) {
      accounted = true;
      metrics.activeStreams = Math.max(0, metrics.activeStreams - 1);
    }
  };

  const body = {
    getReader(): ReadableStreamDefaultReader<Uint8Array> {
      const reader = response.body!.getReader();
      metrics.activeStreams += 1;
      metrics.maxActiveStreams = Math.max(
        metrics.maxActiveStreams,
        metrics.activeStreams
      );

      return {
        read: async () => {
          const result = await reader.read();
          if (result.done) {
            release();
          }
          return result;
        },
        cancel: async () => {
          release();
          return reader.cancel();
        },
        releaseLock: () => {
          reader.releaseLock();
        },
      };
    },
  };

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    json: () => response.json(),
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
    blob: () => response.blob(),
    body,
  } as Response;
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for hooks condition"));
        return;
      }
      setTimeout(tick, 25);
    };

    tick();
  });
}

function toUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input.url);
}
