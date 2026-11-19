import { describe, expect, test } from "bun:test";
import type { FetchRequestInit, FetchResponse, IServiceContext, ServiceHeaders } from "../types";
import { KVService } from "./KVService";
import type { KVListOptions } from "./types";

// TC-2492: KV head reports the stored value's size and modified time; list
// can return each key's size and modified time.

function response(ok: boolean, status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    blob: async () => new Blob([text]),
  };
}

function headerValue(headers: ServiceHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function createContext(fetchImpl: IServiceContext["fetch"]): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: () => ({ Authorization: "Bearer signed-invocation" }),
    fetch: fetchImpl,
    hosts: ["https://node.tinycloud.xyz"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: {
      maxAttempts: 1,
      backoff: "exponential",
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableErrors: [],
    },
  };
}

/** A replica holding `keys` that records the options each list asked it for. */
function replicaWith(keys: string[], seen: Array<KVListOptions | undefined>) {
  return {
    get: async () => {
      throw new Error("unexpected replica get");
    },
    list: async ({ options, network }: { options: KVListOptions | undefined; network: () => Promise<unknown> }) => {
      seen.push(options);
      // A replica that can't serve the list falls back to the network callback.
      if (keys.length === 0) return (await network()) as never;
      return { ok: true as const, data: { keys } };
    },
    write: async () => {
      throw new Error("unexpected replica write");
    },
    observeNetworkRequested: () => undefined,
  };
}

describe("KVService head size and modified time (TC-2492)", () => {
  test("head reports the stored size and modified time, not the empty body's length", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, "", {
      "content-length": "0",
      "x-tinycloud-content-length": "28",
      "last-modified": "Fri, 13 Nov 2026 15:00:00 GMT",
      etag: '"blake3-abc"',
    })));

    const result = await service.head("notes/a");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.headers.contentLength).toBe(28);
    expect(result.data.headers.lastModified).toBe("Fri, 13 Nov 2026 15:00:00 GMT");
  });

  test("head against a node that sends no stored size reports none, not 0", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, "", { "content-length": "0" })));

    const result = await service.head("notes/a");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.headers.contentLength).toBeUndefined();
  });
});

describe("KVService list entries (TC-2492)", () => {
  test("list with entries asks for them and returns each key's size and modified time", async () => {
    const requests: FetchRequestInit[] = [];
    const service = new KVService({ prefix: "app" });
    service.initialize(createContext(async (_url, init) => {
      requests.push(init ?? {});
      return response(true, 200, [
        { key: "app/a", size: 28, updatedAt: "2026-11-13T15:00:00Z" },
        { key: "app/b", size: null, updatedAt: "2026-11-12T09:30:00Z" },
      ]);
    }));

    const result = await service.list({ entries: true, removePrefix: true });

    expect(headerValue(requests[0]?.headers, "x-tinycloud-list-entries")).toBe("true");
    expect(result).toEqual({
      ok: true,
      data: {
        keys: ["a", "b"],
        entries: [
          { key: "a", size: 28, updatedAt: "2026-11-13T15:00:00Z" },
          { key: "b", updatedAt: "2026-11-12T09:30:00Z" },
        ],
      },
    });
  });

  test("an entry the caller may not read carries no size or time, not 0 or null", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(createContext(async () => response(true, 200, [
      { key: "app/open", size: 3, updatedAt: "2026-11-13T15:00:00Z" },
      { key: "app/hidden" },
    ])));

    const result = await service.list({ entries: true, removePrefix: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hidden = result.data.entries?.[1];
    expect(hidden).toStrictEqual({ key: "hidden" });
    expect(hidden !== undefined && "size" in hidden).toBe(false);
    expect(hidden !== undefined && "updatedAt" in hidden).toBe(false);
    expect(result.data.entries?.[0]).toStrictEqual({ key: "open", size: 3, updatedAt: "2026-11-13T15:00:00Z" });
  });

  test("list with entries against a node that returns only keys still lists them", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, ["a", "b"])));

    const result = await service.list({ entries: true });

    expect(result).toEqual({
      ok: true,
      data: { keys: ["a", "b"], entries: [{ key: "a" }, { key: "b" }] },
    });
  });

  test("list without entries sends no entries header and returns keys only", async () => {
    const requests: FetchRequestInit[] = [];
    const service = new KVService({});
    service.initialize(createContext(async (_url, init) => {
      requests.push(init ?? {});
      return response(true, 200, ["a"]);
    }));

    const result = await service.list();

    expect(headerValue(requests[0]?.headers, "x-tinycloud-list-entries")).toBeUndefined();
    expect(result).toEqual({ ok: true, data: { keys: ["a"] } });
  });

  test("entries without a string key are dropped instead of failing the list", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(createContext(async () => response(true, 200, [
      { key: "app/a", size: 1 },
      { size: 2 },
      { key: 7, size: 3 },
      null,
      "app/b",
    ])));

    const result = await service.list({ entries: true, removePrefix: true });

    expect(result).toEqual({
      ok: true,
      data: { keys: ["a", "b"], entries: [{ key: "a", size: 1 }, { key: "b" }] },
    });
  });

  test("offline, a list with entries returns the replica's keys without entries and fetches once", async () => {
    let fetches = 0;
    const seen: Array<KVListOptions | undefined> = [];
    const service = new KVService({});
    service.initialize(createContext(async () => {
      fetches += 1;
      throw new TypeError("fetch failed");
    }));
    service.setReadThrough(replicaWith(["notes/a", "notes/b"], seen));

    const result = await service.list({ prefix: "notes", entries: true });

    expect(result).toEqual({ ok: true, data: { keys: ["notes/a", "notes/b"] } });
    expect(fetches).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.entries).toBe(false);
  });

  test("offline, a replica that can't serve the list reports the network failure", async () => {
    let fetches = 0;
    const service = new KVService({});
    service.initialize(createContext(async () => {
      fetches += 1;
      throw new TypeError("fetch failed");
    }));
    service.setReadThrough(replicaWith([], []));

    const result = await service.list({ prefix: "notes", entries: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(fetches).toBe(1);
  });

  test("a refused list with entries is reported, not replaced by the replica's keys", async () => {
    const seen: Array<KVListOptions | undefined> = [];
    const service = new KVService({});
    service.initialize(createContext(async () => response(false, 403, "forbidden")));
    service.setReadThrough(replicaWith(["notes/a"], seen));

    const result = await service.list({ prefix: "notes", entries: true });

    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
