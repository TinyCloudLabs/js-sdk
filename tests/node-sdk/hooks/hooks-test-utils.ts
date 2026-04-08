type HookMetrics = {
  ticketRequests: number;
  streamRequests: number;
  activeStreams: number;
  maxActiveStreams: number;
};

export function installFetchMetrics(): {
  metrics: HookMetrics;
  restoreFetch: () => void;
} {
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

export function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapStreamResponse(
  response: Response,
  metrics: HookMetrics,
): Response {
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
        metrics.activeStreams,
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
