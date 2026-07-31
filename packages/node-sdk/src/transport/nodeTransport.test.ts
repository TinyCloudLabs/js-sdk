/**
 * Tests for the Node bounded transport (TC-407).
 *
 * These exercise the pool registry directly via `getSharedNodeTransportManager()`
 * rather than through `getDefaultNodeFetch()`, because the test runner itself is
 * Bun (`bun test`), and `getDefaultNodeFetch()`'s Bun-runtime check would always
 * route through plain global fetch under that runner — never exercising the
 * pooled path. Hitting the manager directly is what a Node-only consumer's
 * `getDefaultNodeFetch()` call resolves to at runtime.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  BoundedNodeTransportManager,
  MAX_CONNECTIONS_PER_ORIGIN,
  MAX_QUEUED_PER_ORIGIN,
  MAX_RETAINED_ORIGINS,
  TransportManagerClosedError,
  TransportOriginLimitError,
  TransportQueueLimitError,
  __resetNodeTransportForTests,
  getSharedNodeTransportManager,
} from "./nodeTransport";

/** A local HTTP server that assigns a monotonically increasing ID to each raw TCP connection. */
class ConnectionTrackingServer {
  readonly server: http.Server;
  readonly url: string;
  readonly connectionIdsByRequest: number[] = [];
  activeSockets = 0;
  peakActiveSockets = 0;
  requestCount = 0;

  private nextConnectionId = 0;
  private readonly socketIds = new WeakMap<import("node:net").Socket, number>();

  private constructor(server: http.Server, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(
    handler: (req: http.IncomingMessage, res: http.ServerResponse, connectionId: number) => void,
  ): Promise<ConnectionTrackingServer> {
    const server = http.createServer();
    const instance = new ConnectionTrackingServer(server, "");
    server.on("connection", (socket) => {
      const id = instance.nextConnectionId++;
      instance.socketIds.set(socket, id);
      instance.activeSockets++;
      instance.peakActiveSockets = Math.max(instance.peakActiveSockets, instance.activeSockets);
      socket.on("close", () => {
        instance.activeSockets--;
      });
    });
    server.on("request", (req, res) => {
      instance.requestCount++;
      const socketId = instance.socketIds.get(req.socket) ?? -1;
      instance.connectionIdsByRequest.push(socketId);
      // Fully drain the request body before responding, per test-plan requirement.
      req.resume();
      handler(req, res, socketId);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    (instance as { url: string }).url = `http://127.0.0.1:${port}`;
    return instance;
  }

  distinctConnectionIds(): Set<number> {
    return new Set(this.connectionIdsByRequest);
  }

  async close(): Promise<void> {
    // A destroyed/discarded client-side socket doesn't always propagate to
    // Bun's `node:http` server-side socket bookkeeping promptly (verified:
    // the same destroy-then-reconnect sequence settles immediately under
    // real Node — see nodeTransport.ts's module header). `closeAllConnections`
    // forces the issue; the timeout is a last-resort bound so that Bun-only
    // teardown latency in this test harness can never hang the suite.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      this.server.close((err) => settle(err ?? undefined));
      this.server.closeAllConnections?.();
      setTimeout(() => settle(), 2000).unref();
    });
  }
}

function jsonOk(res: http.ServerResponse, body: unknown = { ok: true }): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let manager: BoundedNodeTransportManager | undefined;
const servers: ConnectionTrackingServer[] = [];

afterEach(async () => {
  if (manager) {
    await manager.shutdown();
    manager = undefined;
  }
  await __resetNodeTransportForTests();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("BoundedNodeTransportManager: sequential reuse", () => {
  test("20 sequential body-consuming requests to one origin use exactly one connection", async () => {
    const server = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    for (let i = 0; i < 20; i++) {
      const res = await manager.fetch(`${server.url}/kv/get`);
      expect(res.ok).toBe(true);
      await res.json();
    }

    expect(server.requestCount).toBe(20);
    expect(server.distinctConnectionIds().size).toBe(1);
  }, 10000);

  test("a server-initiated close after request 10 yields exactly two connections and all requests complete", async () => {
    let requestIndex = 0;
    const server = await ConnectionTrackingServer.start((_req, res) => {
      requestIndex++;
      if (requestIndex === 10) {
        res.setHeader("Connection", "close");
      }
      jsonOk(res, { requestIndex });
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    for (let i = 0; i < 20; i++) {
      const res = await manager.fetch(`${server.url}/kv/get`);
      expect(res.ok).toBe(true);
      await res.json();
    }

    expect(server.requestCount).toBe(20);
    expect(server.distinctConnectionIds().size).toBe(2);
  }, 10000);
});

describe("BoundedNodeTransportManager: concurrency bound", () => {
  test("concurrent requests to one origin never exceed MAX_CONNECTIONS_PER_ORIGIN active sockets", async () => {
    const server = await ConnectionTrackingServer.start((_req, res) => {
      // Hold the response open briefly so several requests overlap in flight.
      setTimeout(() => jsonOk(res), 75);
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const concurrency = MAX_CONNECTIONS_PER_ORIGIN * 3;
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        manager!.fetch(`${server.url}/kv/get`).then((res) => res.json()),
      ),
    );

    expect(server.requestCount).toBe(concurrency);
    expect(server.peakActiveSockets).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_ORIGIN);
  }, 10000);
});

describe("BoundedNodeTransportManager: origin retention bound", () => {
  test("more than MAX_RETAINED_ORIGINS origins never grow the registry past the bound", async () => {
    manager = new BoundedNodeTransportManager();
    const originCount = MAX_RETAINED_ORIGINS + 1;

    for (let i = 0; i < originCount; i++) {
      const server = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
      servers.push(server);
      const res = await manager.fetch(`${server.url}/info`);
      await res.json();
      expect(manager.originCount).toBeLessThanOrEqual(MAX_RETAINED_ORIGINS);
    }

    expect(manager.originCount).toBeLessThanOrEqual(MAX_RETAINED_ORIGINS);
  }, 20000);

  test("more than MAX_RETAINED_ORIGINS concurrent first-time requests to distinct origins never admit more than the bound", async () => {
    manager = new BoundedNodeTransportManager();
    const originCount = MAX_RETAINED_ORIGINS + 1;

    const localServers: ConnectionTrackingServer[] = [];
    for (let i = 0; i < originCount; i++) {
      const server = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
      servers.push(server);
      localServers.push(server);
    }

    // Fire every origin's first request in the same synchronous burst
    // (no `await` between them) so their admission checks race exactly as
    // TransportOriginLimitError's fix targets: none of these origins is
    // registered in `origins` yet when the others' checks run.
    const results = await Promise.allSettled(
      localServers.map((server) => manager!.fetch(`${server.url}/info`).then((res) => res.json())),
    );

    // At most MAX_RETAINED_ORIGINS of the (MAX_RETAINED_ORIGINS + 1)
    // concurrent distinct-origin requests may succeed; the rest must be
    // rejected with TransportOriginLimitError rather than the registry
    // silently growing past the bound.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBeLessThanOrEqual(MAX_RETAINED_ORIGINS);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TransportOriginLimitError);
    }
    expect(manager.originCount).toBeLessThanOrEqual(MAX_RETAINED_ORIGINS);
  }, 20000);
});

describe("BoundedNodeTransportManager: ownership and lifecycle", () => {
  test("getSharedNodeTransportManager() returns the same instance across calls", () => {
    const a = getSharedNodeTransportManager();
    const b = getSharedNodeTransportManager();
    expect(a).toBe(b);
  });

  test("multiple consumers of the shared manager reuse one pool per origin, not one per caller", async () => {
    const server = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
    servers.push(server);

    const shared = getSharedNodeTransportManager();
    // Simulate two independent TinyCloudNode instances resolving the same
    // process-wide default and issuing requests through it.
    const fetchA = shared.fetch;
    const fetchB = shared.fetch;

    for (let i = 0; i < 5; i++) {
      await (await fetchA(`${server.url}/a`)).json();
      await (await fetchB(`${server.url}/b`)).json();
    }

    expect(server.distinctConnectionIds().size).toBe(1);
  }, 10000);

  test("__resetNodeTransportForTests() deterministically closes sockets and starts a fresh manager", async () => {
    const server = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
    servers.push(server);

    const shared = getSharedNodeTransportManager();
    await (await shared.fetch(`${server.url}/kv/get`)).json();
    expect(shared.originCount).toBe(1);

    await __resetNodeTransportForTests();

    const fresh = getSharedNodeTransportManager();
    expect(fresh).not.toBe(shared);
    expect(fresh.originCount).toBe(0);
  }, 10000);
});

describe("BoundedNodeTransportManager: non-2xx error-body release", () => {
  test("reading a non-2xx response body directly (not via .clone()) releases the connection for reuse", async () => {
    // Mirrors TinyCloudNode.registerOwnerSharePolicy's error path: on a
    // non-2xx reply it reads the body once via `.text()`/`JSON.parse` to
    // extract an error code, rather than `.clone().json()` — `clone()`
    // returns an independent `Response` this pool's release tracking never
    // observes being consumed, which used to leak the checked-out client on
    // every non-2xx reply.
    const server = await ConnectionTrackingServer.start((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad_request" } }));
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    for (let i = 0; i < MAX_CONNECTIONS_PER_ORIGIN + 1; i++) {
      const res = await manager.fetch(`${server.url}/share/v2/policies`, { method: "POST" });
      expect(res.ok).toBe(false);
      const body = JSON.parse(await res.text()) as { error: { code: string } };
      expect(body.error.code).toBe("bad_request");
    }

    // More non-2xx requests than the pool has connections all completed
    // above; a release leak would have exhausted every slot and hung this
    // follow-up request behind a queue that never drains.
    expect(server.distinctConnectionIds().size).toBe(1);
  }, 10000);
});

describe("BoundedNodeTransportManager: connection-failure surfacing", () => {
  test("a connection reset after the request body is received surfaces after exactly one attempt", async () => {
    let requestCount = 0;
    const server = await ConnectionTrackingServer.start((req, res) => {
      requestCount++;
      // Destroy the socket after reading the body, without responding —
      // no automatic transport-level retry should paper over this.
      req.on("end", () => res.socket?.destroy());
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    await expect(
      manager.fetch(`${server.url}/kv/put`, {
        method: "POST",
        body: JSON.stringify({ authenticated: true }),
      }),
    ).rejects.toBeTruthy();

    expect(requestCount).toBe(1);
  }, 10000);
});

describe("BoundedNodeTransportManager: Hooks/SSE streaming release", () => {
  test("draining response.body directly (not via .json()/.text()) releases the connection for reuse", async () => {
    const server = await ConnectionTrackingServer.start((req, res) => {
      if (req.url === "/hooks/subscribe") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: hello\n\n");
        res.end();
        return;
      }
      jsonOk(res);
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const streamRes = await manager.fetch(`${server.url}/hooks/subscribe`);
    const reader = streamRes.body!.getReader();
    // Drain to completion exactly like HooksService's async-iterator path.
    while (!(await reader.read()).done) {
      // keep draining
    }

    // A sequential request must reuse the same connection — proof the first
    // request's client was actually released back to the pool once the
    // stream finished, even though `.json()`/`.text()` was never called.
    const kvRes = await manager.fetch(`${server.url}/kv/get`);
    await kvRes.json();

    expect(server.distinctConnectionIds().size).toBe(1);
  }, 10000);

  test("cancelling a response.body stream discards the connection instead of reusing it", async () => {
    const server = await ConnectionTrackingServer.start((req, res) => {
      if (req.url === "/hooks/subscribe") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        // Deliberately never ends — the client cancels instead of waiting.
        return;
      }
      jsonOk(res);
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const streamRes = await manager.fetch(`${server.url}/hooks/subscribe`);
    const reader = streamRes.body!.getReader();
    await reader.read();
    await reader.cancel();

    const kvRes = await manager.fetch(`${server.url}/kv/get`);
    await kvRes.json();

    // A cancelled stream leaves unknown bytes in flight on the socket, so
    // per TC-407's discard policy the connection must be destroyed rather
    // than reused — the follow-up request opens a fresh, second connection.
    expect(server.distinctConnectionIds().size).toBe(2);
  }, 10000);

  test("repeatedly opening and cancelling streams does not starve ordinary KV traffic on the same origin", async () => {
    const server = await ConnectionTrackingServer.start((req, res) => {
      if (req.url === "/hooks/subscribe") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: tick\n\n");
        // Never ends on its own — every stream is cancelled by the client.
        return;
      }
      jsonOk(res);
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    // Open and cancel more streams than the pool has connections. A release
    // leak would permanently occupy the whole pool after this loop.
    for (let i = 0; i < MAX_CONNECTIONS_PER_ORIGIN * 2; i++) {
      const streamRes = await manager.fetch(`${server.url}/hooks/subscribe`);
      const reader = streamRes.body!.getReader();
      await reader.read();
      await reader.cancel();
    }

    const kvRes = await manager.fetch(`${server.url}/kv/get`);
    expect((await kvRes.json()).ok).toBe(true);
  }, 10000);
});

describe("BoundedNodeTransportManager: active-origin pressure", () => {
  test("a new origin is rejected with TransportOriginLimitError when every retained origin is active", async () => {
    manager = new BoundedNodeTransportManager();
    const releaseFns: Array<() => void> = [];
    const pending: Array<Promise<unknown>> = [];

    for (let i = 0; i < MAX_RETAINED_ORIGINS; i++) {
      const server = await ConnectionTrackingServer.start((_req, res) => {
        releaseFns.push(() => jsonOk(res));
        // Deliberately do not respond yet, so this origin's pool stays
        // checked-out (active) rather than idle.
      });
      servers.push(server);
      pending.push(manager.fetch(`${server.url}/kv/get`).catch(() => undefined));
      // Flush microtasks so the checkout registers before the next iteration.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(manager.originCount).toBe(MAX_RETAINED_ORIGINS);

    const extraServer = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
    servers.push(extraServer);

    await expect(manager.fetch(`${extraServer.url}/kv/get`)).rejects.toThrow(
      TransportOriginLimitError,
    );
    expect(manager.originCount).toBe(MAX_RETAINED_ORIGINS);

    for (const release of releaseFns) release();
    await Promise.all(pending);
  }, 20000);
});

describe("BoundedNodeTransportManager: queue limit", () => {
  test("a request beyond MAX_QUEUED_PER_ORIGIN rejects immediately with TransportQueueLimitError instead of queuing", async () => {
    const server = await ConnectionTrackingServer.start(() => {
      // Never respond — keeps every checked-out connection permanently busy
      // and every queued request permanently queued.
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const saturating = Array.from({ length: MAX_CONNECTIONS_PER_ORIGIN }, () =>
      manager!.fetch(`${server.url}/kv/get`).catch(() => undefined),
    );
    // Let all MAX_CONNECTIONS_PER_ORIGIN connections actually check out.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const queued = Array.from({ length: MAX_QUEUED_PER_ORIGIN }, () =>
      manager!.fetch(`${server.url}/kv/get`).catch(() => undefined),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The 65th request (4 checked out + 64 queued already) must be rejected
    // outright rather than growing the queue past its bound.
    await expect(manager.fetch(`${server.url}/kv/get`)).rejects.toBeInstanceOf(
      TransportQueueLimitError,
    );

    await manager.shutdown();
    // The saturating requests were already dispatched when their client was
    // destroyed. Node's fetch reliably rejects a dispatch whose dispatcher
    // was destroyed mid-flight (verified directly against undici under
    // Node), but Bun's fetch does not always propagate that same rejection
    // for an already-running request — bound the wait so a Bun-only
    // dispatcher-teardown quirk in this test's runtime can never hang the
    // suite; the queue-limit assertion above is what this test exists to
    // verify.
    await Promise.race([
      Promise.all([...saturating, ...queued]),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }, 10000);
});

describe("BoundedNodeTransportManager: closed state", () => {
  test("fetch() rejects with TransportManagerClosedError after shutdown() instead of opening new connections", async () => {
    const server = await ConnectionTrackingServer.start((_req, res) => jsonOk(res));
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    await (await manager.fetch(`${server.url}/kv/get`)).json();
    await manager.shutdown();

    await expect(manager.fetch(`${server.url}/kv/get`)).rejects.toBeInstanceOf(
      TransportManagerClosedError,
    );
    // No new origin should have been opened for the post-shutdown attempt.
    expect(manager.originCount).toBe(0);
    manager = undefined;
  }, 10000);
});

describe("BoundedNodeTransportManager: abort after headers", () => {
  test("aborting the request signal after headers arrive discards the connection instead of leaking the slot", async () => {
    const server = await ConnectionTrackingServer.start((req, res) => {
      if (req.url === "/hooks/subscribe") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        // Deliberately never ends — the client aborts instead of the stream
        // ever finishing naturally.
        return;
      }
      jsonOk(res);
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const controller = new AbortController();
    const res = await manager.fetch(`${server.url}/hooks/subscribe`, {
      signal: controller.signal,
    });
    // Headers have arrived (the promise above settled); abort now, without
    // reading or cancelling the body through any other path.
    controller.abort();
    // Let the abort listener's discard-and-replace logic run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    void res;

    // A follow-up request must still succeed — proof the aborted response's
    // checked-out client was discarded and its slot replaced rather than
    // left permanently occupied.
    const kvRes = await manager.fetch(`${server.url}/kv/get`);
    expect((await kvRes.json()).ok).toBe(true);
  }, 10000);

  test("aborting via a signal carried on the Request input (not RequestInit) discards the connection instead of leaking the slot", async () => {
    const server = await ConnectionTrackingServer.start((req, res) => {
      if (req.url === "/hooks/subscribe") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        // Deliberately never ends — the client aborts instead of the stream
        // ever finishing naturally.
        return;
      }
      jsonOk(res);
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const controller = new AbortController();
    // No `init.signal` here — the signal is only reachable via the `Request`
    // object itself, exactly the shape `resolveEffectiveSignal` exists for.
    const request = new Request(`${server.url}/hooks/subscribe`, { signal: controller.signal });
    const res = await manager.fetch(request);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    void res;

    const kvRes = await manager.fetch(`${server.url}/kv/get`);
    expect((await kvRes.json()).ok).toBe(true);
  }, 10000);
});

describe("BoundedNodeTransportManager: shutdown rejects queued acquisitions", () => {
  test("shutdown() rejects a request queued for a connection instead of hanging", async () => {
    const server = await ConnectionTrackingServer.start(() => {
      // Never respond — keeps every checked-out connection permanently busy.
    });
    servers.push(server);
    manager = new BoundedNodeTransportManager();

    const saturating = Array.from({ length: MAX_CONNECTIONS_PER_ORIGIN }, () =>
      manager!.fetch(`${server.url}/kv/get`).catch(() => undefined),
    );
    // Let all MAX_CONNECTIONS_PER_ORIGIN connections actually check out.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A 5th request has no free connection, so it queues behind a waiter
    // instead of opening a 5th connection.
    const queued = manager.fetch(`${server.url}/kv/get`);

    await manager.shutdown();
    const shutdownManager = manager;
    manager = undefined;

    await expect(queued).rejects.toThrow(/closed while a request was/);
    // The saturating requests were already dispatched when their client was
    // destroyed. Node's fetch reliably rejects a dispatch whose dispatcher
    // was destroyed mid-flight (verified directly against undici under
    // Node), but Bun's fetch does not always propagate that same rejection
    // for an already-running request — bound the wait so a Bun-only
    // dispatcher-teardown quirk in this test's runtime can never hang the
    // suite; the queued-waiter assertion above is what this test exists to
    // verify.
    await Promise.race([Promise.all(saturating), new Promise((resolve) => setTimeout(resolve, 2000))]);
    void shutdownManager;
  }, 10000);
});
