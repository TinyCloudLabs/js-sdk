/**
 * Tests for activateSessionWithHost in space.ts.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { activateSessionWithHost } from "./space";

/**
 * The real `fetch`, captured at import time before any test replaces it.
 * Bun shares one process across test files, so a stubbed global must always be
 * put back or it leaks into unrelated suites.
 */
const REAL_FETCH = globalThis.fetch;

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_HOST = "https://node.tinycloud.xyz";
const TEST_DELEGATION_HEADER = { Authorization: "Bearer ucan-delegation-token" };

function mockFetchResponse(body: any, init?: ResponseInit): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    init
  );
}

// =============================================================================
// activateSessionWithHost Tests
// =============================================================================

describe("activateSessionWithHost", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    globalThis.fetch = mock() as any;
  });

  it("returns success with activated/skipped arrays on JSON response", async () => {
    const responseBody = {
      activated: ["space-1", "space-2"],
      skipped: ["space-3"],
    };
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse(responseBody, { status: 200 })
    );

    const result = await activateSessionWithHost(TEST_HOST, TEST_DELEGATION_HEADER);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.activated).toEqual(["space-1", "space-2"]);
    expect(result.skipped).toEqual(["space-3"]);
  });

  it("falls back gracefully for old servers returning non-JSON body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse("bafy2bzacea...", { status: 200 })
    );

    const result = await activateSessionWithHost(TEST_HOST, TEST_DELEGATION_HEADER);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.activated).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("returns failure on 404 response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse("Space not found", { status: 404 })
    );

    const result = await activateSessionWithHost(TEST_HOST, TEST_DELEGATION_HEADER);

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe("Space not found");
  });

  it("returns failure on 500 response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse("Internal server error", { status: 500 })
    );

    const result = await activateSessionWithHost(TEST_HOST, TEST_DELEGATION_HEADER);

    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe("Internal server error");
  });

  it("falls back to statusText when body read fails on error response", async () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" });
    // Override text() to reject — use defineProperty since text is read-only
    Object.defineProperty(response, "text", {
      value: () => Promise.reject(new Error("body stream already read")),
    });
    (globalThis.fetch as any).mockResolvedValueOnce(response);

    const result = await activateSessionWithHost(TEST_HOST, TEST_DELEGATION_HEADER);

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Bad Gateway");
  });

  it("sends POST to {host}/delegate with delegation header", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse({ activated: [], skipped: [] }, { status: 200 })
    );

    await activateSessionWithHost(TEST_HOST, TEST_DELEGATION_HEADER);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${TEST_HOST}/delegate`,
      {
        method: "POST",
        headers: TEST_DELEGATION_HEADER,
      }
    );
  });

  it("composes correct URL with localhost host", async () => {
    const localhostHost = "http://localhost:8000";
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse({ activated: [], skipped: [] }, { status: 200 })
    );

    await activateSessionWithHost(localhostHost, TEST_DELEGATION_HEADER);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8000/delegate",
      {
        method: "POST",
        headers: TEST_DELEGATION_HEADER,
      }
    );
  });
});

// =============================================================================
// TC-332: single-flight / de-duplication of concurrent identical activations
//
// A parentless *root* session delegation acquires zero guard locks on the node
// (`delegate()` derives guard roots from parents only). On PostgreSQL there is
// no `writer_lock`, so two byte-identical concurrent POST /delegate requests
// race into the same `epoch_hash`; the loser takes SQLSTATE 23505 on the
// `pk-epoch` constraint and the SDK sees an HTTP 500.
//
// The SDK-side fix is to coalesce concurrent identical activations into a
// single in-flight request.
// =============================================================================

/**
 * A distinct delegation token per call.
 *
 * Real delegation headers are minted per SIWE signature and are unique per
 * session; reusing one literal across tests would couple them through the
 * module-level in-flight map.
 */
let tokenCounter = 0;
function uniqueHeader(): { Authorization: string } {
  tokenCounter += 1;
  return { Authorization: `Bearer root-delegation-${tokenCounter}` };
}

/** A promise plus its resolve/reject handles. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Installs a `fetch` that records every call and hands control of each
 * response back to the test via a deferred.
 */
function installControllableFetch() {
  const calls: string[] = [];
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];

  globalThis.fetch = ((url: string) => {
    calls.push(url);
    const d = deferred<Response>();
    pending.push(d);
    return d.promise;
  }) as unknown as typeof fetch;

  return {
    calls,
    pending,
    /** Resolve every outstanding fetch with a 200 JSON activation receipt. */
    settleAllOk(cid = "bafyreiactivated") {
      for (const d of pending.splice(0)) {
        d.resolve(
          mockFetchResponse({ cid, activated: ["space-1"], skipped: [] }, { status: 200 })
        );
      }
    },
    /** Reject every outstanding fetch as a network-level failure. */
    rejectAll(error: Error) {
      for (const d of pending.splice(0)) {
        d.reject(error);
      }
    },
  };
}

describe("activateSessionWithHost single-flight (TC-332)", () => {
  beforeEach(() => {
    globalThis.fetch = mock() as any;
  });

  afterEach(() => {
    // `installControllableFetch` installs a `fetch` that never settles on its
    // own. Leaving it in place would hang any later suite that does real I/O.
    globalThis.fetch = REAL_FETCH;
  });

  it("coalesces N concurrent identical activations into exactly one fetch", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    const flights = Array.from({ length: 7 }, () =>
      activateSessionWithHost(TEST_HOST, header)
    );

    // Let every caller reach its `await` before any response lands.
    await Promise.resolve();
    expect(controller.calls.length).toBe(1);

    controller.settleAllOk();
    const results = await Promise.all(flights);

    expect(controller.calls).toEqual([`${TEST_HOST}/delegate`]);
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.activated).toEqual(["space-1"]);
      expect(result.commitEventCid).toBe("bafyreiactivated");
    }
  });

  it("coalesces identical activations passed as distinct but equal header objects", async () => {
    const controller = installControllableFetch();

    // Real call sites pass `session.delegationHeader` by reference, but a
    // structurally equal object must coalesce too — the node only sees bytes.
    const flights = Array.from({ length: 5 }, () =>
      activateSessionWithHost(TEST_HOST, { Authorization: "Bearer same-bytes" })
    );

    await Promise.resolve();
    expect(controller.calls.length).toBe(1);

    controller.settleAllOk();
    await Promise.all(flights);
    expect(controller.calls.length).toBe(1);
  });

  it("does not coalesce concurrent activations with distinct headers", async () => {
    const controller = installControllableFetch();

    const flights = Array.from({ length: 5 }, (_, i) =>
      activateSessionWithHost(TEST_HOST, { Authorization: `Bearer delegation-${i}` })
    );

    await Promise.resolve();
    expect(controller.calls.length).toBe(5);

    controller.settleAllOk();
    await Promise.all(flights);
    expect(controller.calls.length).toBe(5);
  });

  it("keys on the whole header, not a prefix of it", async () => {
    const controller = installControllableFetch();

    // Two tokens sharing a long common prefix and differing only in the final
    // characters. A truncated cache key would wrongly coalesce these.
    const prefix = `Bearer ${"u".repeat(512)}`;
    const flights = [
      activateSessionWithHost(TEST_HOST, { Authorization: `${prefix}AAAA` }),
      activateSessionWithHost(TEST_HOST, { Authorization: `${prefix}BBBB` }),
    ];

    await Promise.resolve();
    expect(controller.calls.length).toBe(2);

    controller.settleAllOk();
    await Promise.all(flights);
    expect(controller.calls.length).toBe(2);
  });

  it("does not coalesce the same header across different hosts", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    const flights = [
      activateSessionWithHost("https://node.tinycloud.xyz", header),
      activateSessionWithHost("http://127.0.0.1:54108", header),
    ];

    await Promise.resolve();
    expect(controller.calls).toEqual([
      "https://node.tinycloud.xyz/delegate",
      "http://127.0.0.1:54108/delegate",
    ]);

    controller.settleAllOk();
    await Promise.all(flights);
    expect(controller.calls.length).toBe(2);
  });

  it("issues a fresh request for a sequential call after the flight settles", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    const first = activateSessionWithHost(TEST_HOST, header);
    await Promise.resolve();
    controller.settleAllOk();
    await first;

    // Activation is a server-side mutation whose response reflects live space
    // state; completed results must never be replayed from cache.
    const second = activateSessionWithHost(TEST_HOST, header);
    await Promise.resolve();
    expect(controller.calls.length).toBe(2);

    controller.settleAllOk();
    await second;
    expect(controller.calls.length).toBe(2);
  });

  it("lets a joining caller recover on its own when the shared flight fails at the network level", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    // A caller that joins an in-flight request must never end up worse off than
    // it would have been issuing its own request. A background activation that
    // dies on a transient network error must not take a legitimate concurrent
    // caller down with it.
    const originator = activateSessionWithHost(TEST_HOST, header);
    const joiner = activateSessionWithHost(TEST_HOST, header);

    await Promise.resolve();
    expect(controller.calls.length).toBe(1);

    controller.rejectAll(new Error("network down"));

    // The originator genuinely failed, so it rejects.
    await expect(originator).rejects.toThrow("network down");

    // The joiner gets a second, independent attempt.
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.calls.length).toBe(2);
    controller.settleAllOk();
    expect((await joiner).success).toBe(true);
  });

  it("bounds the network-failure path at two requests however many callers coalesce", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    const flights = Array.from({ length: 6 }, () =>
      activateSessionWithHost(TEST_HOST, header)
    );
    // Attach handlers up front so the rejections below are never "unhandled".
    const settledPromise = Promise.allSettled(flights);

    await Promise.resolve();
    expect(controller.calls.length).toBe(1);
    controller.rejectAll(new Error("network down"));

    // The five displaced joiners share one replacement request, not five.
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.calls.length).toBe(2);

    // When the replacement also fails, everyone rejects — no further attempts.
    controller.rejectAll(new Error("still down"));
    const settled = await settledPromise;

    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(controller.calls.length).toBe(2);
  });

  it("does not poison later retries after a rejected flight", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    // `withAccountRegistryRetry` reruns the whole task, sequentially, with the
    // same header. A rejected flight must be evicted so the next attempt is a
    // real request rather than the cached failure.
    const first = activateSessionWithHost(TEST_HOST, header);
    await Promise.resolve();
    expect(controller.calls.length).toBe(1);
    controller.rejectAll(new Error("network down"));
    await expect(first).rejects.toThrow("network down");

    const retry = activateSessionWithHost(TEST_HOST, header);
    await Promise.resolve();
    expect(controller.calls.length).toBe(2);

    controller.settleAllOk();
    expect((await retry).success).toBe(true);
  });

  it("evicts the flight before callers observe the rejection, so a retry in the catch handler is fresh", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    // A caller that retries synchronously from its own rejection handler must
    // not be handed back the already-rejected shared promise.
    const chained = activateSessionWithHost(TEST_HOST, header).catch(() =>
      activateSessionWithHost(TEST_HOST, header)
    );

    await Promise.resolve();
    expect(controller.calls.length).toBe(1);
    controller.rejectAll(new Error("network down"));

    // Give the rejection handler a chance to fire and issue the retry.
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.calls.length).toBe(2);

    controller.settleAllOk();
    const result = await chained;
    expect(result.success).toBe(true);
  });

  it("does not coalesce a failed HTTP result into later calls", async () => {
    const controller = installControllableFetch();
    const header = uniqueHeader();

    const flights = Array.from({ length: 3 }, () =>
      activateSessionWithHost(TEST_HOST, header)
    );
    await Promise.resolve();
    expect(controller.calls.length).toBe(1);

    for (const d of controller.pending.splice(0)) {
      d.resolve(mockFetchResponse("Internal server error", { status: 500 }));
    }
    const results = await Promise.all(flights);
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.status).toBe(500);
    }

    // A 500 is a resolved (not rejected) result; the entry must still be gone.
    const retry = activateSessionWithHost(TEST_HOST, header);
    await Promise.resolve();
    expect(controller.calls.length).toBe(2);

    controller.settleAllOk();
    expect((await retry).success).toBe(true);
  });
});
