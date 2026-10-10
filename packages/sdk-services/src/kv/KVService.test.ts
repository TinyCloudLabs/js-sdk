import { describe, expect, jest, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
  InvokeAnyEntry,
  Result,
  ServiceHeaders,
} from "../types";
import { ErrorCodes } from "../types";
import { authorizationVerdictOf, validatedCapabilityOf } from "../errors";
import { KVService } from "./KVService";
import {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  KVAction,
  type KVChangesOptions,
  type KVChangesResponse,
} from "./types";

function response(
  ok: boolean,
  status: number,
  body: unknown,
  statusText = ok ? "OK" : "Error"
): FetchResponse {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: () => null,
    },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () =>
      new TextEncoder().encode(
        typeof body === "string" ? body : JSON.stringify(body)
      ).buffer as ArrayBuffer,
    blob: async () =>
      new Blob([typeof body === "string" ? body : JSON.stringify(body)]),
  };
}

function headerValue(headers: ServiceHeaders | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return match?.[1];
}

function createContext(
  fetchImpl: IServiceContext["fetch"],
  invokeCalls: Array<{ service: string; path: string; action: string }> = [],
  invokeAnyCalls?: Array<{ entries: InvokeAnyEntry[] }>
): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: (_session, service, path, action) => {
      invokeCalls.push({ service, path, action });
      return {
        Authorization: "Bearer signed-invocation",
        "x-test-path": path,
      };
    },
    invokeAny: invokeAnyCalls
      ? (_session, entries) => {
          invokeAnyCalls.push({ entries });
          return {
            Authorization: "Bearer signed-batch-invocation",
          };
        }
      : undefined,
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
  };
}

describe("KVService batch reads", () => {
  test("uses an exact delegated prefix unchanged for an empty relative key", async () => {
    const invocations: Array<{ service: string; path: string; action: string }> = [];
    const service = new KVService({ prefix: "xyz.tinycloud.share/shares/exact.bin" });
    service.initialize(createContext(async () => response(true, 200, "bytes"), invocations));

    await expect(service.get("", { binary: true })).resolves.toMatchObject({ ok: true });
    expect(invocations).toEqual([{
      service: "kv",
      path: "xyz.tinycloud.share/shares/exact.bin",
      action: "tinycloud.kv/get",
    }]);
  });

  test("reduces three gets from three signatures and requests to one", async () => {
    const individualInvocations: Array<{
      service: string;
      path: string;
      action: string;
    }> = [];
    let individualFetches = 0;
    const individual = new KVService({ prefix: "app" });
    individual.initialize(
      createContext(async () => {
        individualFetches++;
        return response(true, 200, { value: 1 });
      }, individualInvocations)
    );
    await Promise.all(["a", "b", "c"].map((key) => individual.get(key)));

    const batchInvocations: Array<{ entries: InvokeAnyEntry[] }> = [];
    let batchFetches = 0;
    const batch = new KVService({ prefix: "app" });
    batch.initialize(
      createContext(async () => {
        batchFetches++;
        return response(true, 200, {
          results: ["a", "b", "c"].map((key) => ({
            key: `app/${key}`,
            ok: true,
            dataBase64: btoa(JSON.stringify({ key })),
            headers: { "content-type": "application/json" },
          })),
        });
      }, [], batchInvocations)
    );
    const result = await batch.batchGet<{ key: string }>(["a", "b", "c"]);

    expect([individualInvocations.length, individualFetches]).toEqual([3, 3]);
    expect([batchInvocations.length, batchFetches]).toEqual([1, 1]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.data.results.map((item) =>
          item.result.ok ? item.result.data.data.key : "failed"
        )
      ).toEqual(["a", "b", "c"]);
    }
  });

  test("returns missing keys as explicit per-item failures", async () => {
    const invokeAnyCalls: Array<{ entries: InvokeAnyEntry[] }> = [];
    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () =>
        response(true, 200, {
          results: [
            {
              key: "app/found",
              ok: true,
              dataBase64: btoa("hello"),
              headers: { "content-type": "text/plain" },
            },
            {
              key: "app/missing",
              ok: false,
              error: {
                code: ErrorCodes.KV_NOT_FOUND,
                message: "Key not found: app/missing",
              },
            },
          ],
        }), [], invokeAnyCalls)
    );

    const result = await service.batchGet<string>(["found", "missing"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results[0]!.result).toMatchObject({
        ok: true,
        data: { data: "hello" },
      });
      expect(result.data.results[1]!.result).toMatchObject({
        ok: false,
        error: { code: ErrorCodes.KV_NOT_FOUND },
      });
    }
  });

  test("batchHead and prefixed batchGet preserve caller keys", async () => {
    const invokeAnyCalls: Array<{ entries: InvokeAnyEntry[] }> = [];
    let call = 0;
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        call++;
        return response(true, 200, {
          results: ["one", "two"].map((key) => ({
            key: `/audio/${key}`,
            ok: true,
            ...(call === 2 ? { dataBase64: btoa(key) } : {}),
            headers: {
              "content-type": "text/plain",
              "content-length": String(key.length),
            },
          })),
        });
      }, [], invokeAnyCalls)
    );

    const prefixed = service.withPrefix("/audio");
    const head = await prefixed.batchHead(["one", "two"]);
    const get = await prefixed.batchGet<string>(["one", "two"]);
    expect(head.ok && head.data.results[0]!.key).toBe("one");
    expect(get.ok && get.data.results[0]!.key).toBe("one");
    expect(invokeAnyCalls.map((entry) => entry.entries[0]!.path)).toEqual([
      "/audio/one",
      "/audio/one",
    ]);
  });

  test("rejects duplicate resolved keys before signing", async () => {
    const invokeAnyCalls: Array<{ entries: InvokeAnyEntry[] }> = [];
    let fetches = 0;
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        fetches++;
        return response(true, 200, {});
      }, [], invokeAnyCalls)
    );
    const result = await service.batchGet(["same", "same"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
    }
    expect(invokeAnyCalls).toHaveLength(0);
    expect(fetches).toBe(0);
  });

  test("matches unsorted batchGet results by response key in caller order", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () =>
        response(true, 200, {
          // The node returns results in byte-sorted path order.
          results: ["a", "b"].map((key) => ({
            key: `app/${key}`,
            ok: true,
            dataBase64: btoa(`value-${key}`),
            headers: { "content-type": "text/plain" },
          })),
        }), [], [])
    );

    const result = await service.batchGet<string>(["b", "a"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results.map((item) => item.key)).toEqual(["b", "a"]);
      expect(
        result.data.results.map((item) =>
          item.result.ok ? item.result.data.data : "failed"
        )
      ).toEqual(["value-b", "value-a"]);
    }
  });

  test("matches unsorted batchHead results by response key in caller order", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () =>
        response(true, 200, {
          results: ["beta", "delta"].map((key) => ({
            key: `app/${key}`,
            ok: true,
            headers: { "content-type": "text/plain", "content-length": "3" },
          })),
        }), [], [])
    );

    const result = await service.batchHead(["delta", "beta"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results.map((item) => item.key)).toEqual(["delta", "beta"]);
      expect(result.data.results.every((item) => item.result.ok)).toBe(true);
    }
  });

  test("keeps absent keys as per-item failures for unsorted requests", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () =>
        response(true, 200, {
          results: [
            {
              key: "app/a",
              ok: true,
              dataBase64: btoa("va"),
              headers: { "content-type": "text/plain" },
            },
            {
              key: "app/c",
              ok: true,
              dataBase64: btoa("vc"),
              headers: { "content-type": "text/plain" },
            },
            {
              key: "app/missing",
              ok: false,
              error: {
                code: ErrorCodes.KV_NOT_FOUND,
                message: "Key not found: app/missing",
              },
            },
          ],
        }), [], [])
    );

    const result = await service.batchGet<string>(["missing", "c", "a"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results.map((item) => item.key)).toEqual([
        "missing",
        "c",
        "a",
      ]);
      expect(result.data.results[0]!.result).toMatchObject({
        ok: false,
        error: { code: ErrorCodes.KV_NOT_FOUND },
      });
      expect(result.data.results[1]!.result).toMatchObject({
        ok: true,
        data: { data: "vc" },
      });
      expect(result.data.results[2]!.result).toMatchObject({
        ok: true,
        data: { data: "va" },
      });
    }
  });

  test("aligns keyless batch results by the node's byte-sorted path order", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () =>
        response(true, 200, {
          results: [
            {
              ok: true,
              dataBase64: btoa("va"),
              headers: { "content-type": "text/plain" },
            },
            {
              ok: true,
              dataBase64: btoa("vb"),
              headers: { "content-type": "text/plain" },
            },
          ],
        }), [], [])
    );

    const result = await service.batchGet<string>(["b", "a"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results.map((item) => item.key)).toEqual(["b", "a"]);
      expect(
        result.data.results.map((item) =>
          item.result.ok ? item.result.data.data : "failed"
        )
      ).toEqual(["vb", "va"]);
    }
  });

  test("fails closed when the response carries an unrequested key", async () => {
    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () =>
        response(true, 200, {
          results: [
            {
              key: "app/a",
              ok: true,
              dataBase64: btoa("va"),
              headers: { "content-type": "text/plain" },
            },
            {
              key: "app/other",
              ok: true,
              dataBase64: btoa("vo"),
              headers: { "content-type": "text/plain" },
            },
          ],
        }), [], [])
    );

    const result = await service.batchGet(["a", "b"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
    }
  });

  test("fails closed when response count or keying is inconsistent", async () => {
    const service = new KVService({ prefix: "app" });
    const item = {
      ok: true,
      dataBase64: btoa("va"),
      headers: { "content-type": "text/plain" },
    };
    let call = 0;
    service.initialize(
      createContext(async () => {
        call++;
        // 1: fewer results than requested. 2: mixed keyed/keyless items.
        return response(true, 200, {
          results:
            call === 1
              ? [{ ...item, key: "app/a" }]
              : [{ ...item, key: "app/a" }, { ...item }],
        });
      }, [], [])
    );

    for (const keys of [["a", "b"], ["a", "b"]] as const) {
      const result = await service.batchGet([...keys]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      }
    }
    expect(call).toBe(2);
  });
});

describe("KVService.batchPut", () => {
  test("writes multiple keys with one invokeAny multipart request", async () => {
    const invokeAnyCalls: Array<{ entries: InvokeAnyEntry[] }> = [];
    let requestUrl: string | undefined;
    let requestInit: FetchRequestInit | undefined;

    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return response(true, 200, {
          written: ["app/settings.json", "app/transcript/abc%3A1"],
          count: 2,
        });
      }, [], invokeAnyCalls)
    );

    const result = await service.batchPut([
      { key: "settings.json", value: { theme: "dark" } },
      {
        key: "transcript/abc%3A1",
        value: "hello",
        contentType: "text/plain",
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        written: ["app/settings.json", "app/transcript/abc%3A1"],
        count: 2,
      });
    }

    expect(invokeAnyCalls).toEqual([
      {
        entries: [
          {
            spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
            service: "kv",
            path: "app/settings.json",
            action: KVAction.PUT,
          },
          {
            spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
            service: "kv",
            path: "app/transcript/abc%3A1",
            action: KVAction.PUT,
          },
        ],
      },
    ]);
    expect(requestUrl).toBe("https://node.tinycloud.xyz/invoke");
    expect(requestInit?.method).toBe("POST");
    expect(headerValue(requestInit?.headers, "authorization")).toBe(
      "Bearer signed-batch-invocation"
    );
    expect(headerValue(requestInit?.headers, "content-type")).toBeUndefined();
    expect(requestInit?.body).toBeInstanceOf(FormData);

    const form = requestInit!.body as FormData;
    const settings = form.get("app%2Fsettings.json") as Blob;
    const transcript = form.get("app%2Ftranscript%2Fabc%253A1") as Blob;
    expect(await settings.text()).toBe(JSON.stringify({ theme: "dark" }));
    expect(settings.type).toStartWith("application/json");
    expect(await transcript.text()).toBe("hello");
    expect(transcript.type).toStartWith("text/plain");
  });

  test("applies prefixed KV paths", async () => {
    const invokeAnyCalls: Array<{ entries: InvokeAnyEntry[] }> = [];
    let requestInit: FetchRequestInit | undefined;

    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, {
          written: ["/audio/conv-1", "/audio/conv-2"],
          count: 2,
        });
      }, [], invokeAnyCalls)
    );

    const result = await service.withPrefix("/audio").batchPut([
      { key: "conv-1", value: "one" },
      { key: "conv-2", value: "two" },
    ]);

    expect(result.ok).toBe(true);
    expect(invokeAnyCalls[0].entries.map((entry) => entry.path)).toEqual([
      "/audio/conv-1",
      "/audio/conv-2",
    ]);
    const form = requestInit!.body as FormData;
    expect(await (form.get("%2Faudio%2Fconv-1") as Blob).text()).toBe("one");
    expect(await (form.get("%2Faudio%2Fconv-2") as Blob).text()).toBe("two");
  });

  test("rejects duplicate keys after prefix resolution before signing", async () => {
    const invokeAnyCalls: Array<{ entries: InvokeAnyEntry[] }> = [];
    let fetchCalls = 0;

    const service = new KVService({ prefix: "app" });
    service.initialize(
      createContext(async () => {
        fetchCalls++;
        return response(true, 200, {});
      }, [], invokeAnyCalls)
    );

    const result = await service.batchPut([
      { key: "same", value: "one" },
      { key: "same", value: "two" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
    }
    expect(invokeAnyCalls).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("requires invokeAny support", async () => {
    let fetchCalls = 0;

    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        fetchCalls++;
        return response(true, 200, {});
      })
    );

    const result = await service.batchPut([{ key: "a", value: "one" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
    }
    expect(fetchCalls).toBe(0);
  });

  // TC-373 point 6: validate against the EXACT requested path set and count,
  // not just internal self-consistency (count === written.length would
  // accept a malformed response reporting the right count for wrong keys).
  const FIVE_KEYS = ["default", "applications", "account", "secrets", "public"].map(
    (name) => `spaces/tinycloud:pkh:eip155:1:0xabc:${name}`
  );
  function fiveItems() {
    return FIVE_KEYS.map((key, i) => ({ key, value: { spaceId: key, index: i } }));
  }

  test("accepts a response confirming all 5 requested keys were written", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        response(true, 200, { written: [...FIVE_KEYS], count: 5 }), [], []
      )
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(true);
  });

  test("rejects a response reporting the right count but the wrong keys", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        // Internally consistent (count === written.length === 5) but one
        // requested key was swapped for an unrelated one.
        response(true, 200, {
          written: [...FIVE_KEYS.slice(0, 4), "spaces/not-what-was-requested"],
          count: 5,
        }), [], []
      )
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.message).toContain("5 requested key(s)");
      // TC-373 §2a: the node DID answer 2xx, so the ambiguity is carried in
      // meta rather than a new error code (Sol B4).
      expect(result.error.meta).toEqual({
        requestMayHaveDispatched: true,
        responseReceived: true,
        status: 200,
        outcome: "batch-unconfirmed",
      });
    }
  });

  test("rejects a response with fewer written keys than requested, even if internally consistent", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        // count === written.length (4 === 4), but only 4 of the 5 requested
        // keys are reported written — a partial write must not look like success.
        response(true, 200, { written: FIVE_KEYS.slice(0, 4), count: 4 }), [], []
      )
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta).toEqual({
        requestMayHaveDispatched: true,
        responseReceived: true,
        status: 200,
        outcome: "batch-unconfirmed",
      });
    }
  });

  test("rejects a response with duplicate written keys padding the count to look complete", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        // count (5) === written.length (5), and every written key IS one of
        // the requested keys — but one key is duplicated and another is
        // missing entirely. The exact-SET check catches this; a naive
        // count-only check would not.
        response(true, 200, {
          written: [...FIVE_KEYS.slice(0, 4), FIVE_KEYS[0]],
          count: 5,
        }), [], []
      )
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    // Sol B6d: this test asserted only result.ok === false before; give it
    // the same explicit code + meta assertions as its siblings.
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta).toEqual({
        requestMayHaveDispatched: true,
        responseReceived: true,
        status: 200,
        outcome: "batch-unconfirmed",
      });
    }
  });

  test("rejects a 2xx response whose body cannot be normalized at all (missing written/count)", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () => response(true, 200, {}), [], [])
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta).toEqual({
        requestMayHaveDispatched: true,
        responseReceived: true,
        status: 200,
        outcome: "batch-unconfirmed",
      });
    }
  });

  test("a fetch-level throw (post-dispatch) is NETWORK_ERROR with requestMayHaveDispatched: true", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        throw new Error("connection reset");
      }, [], [])
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta?.requestMayHaveDispatched).toBe(true);
    }
  });

  test("a fetch-level TimeoutError throw is TIMEOUT with requestMayHaveDispatched: true", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        const timeoutError = new Error("the operation timed out");
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }, [], [])
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.TIMEOUT);
      expect(result.error.meta?.requestMayHaveDispatched).toBe(true);
    }
  });

  test("a pre-fetch invokeAny throw (plain Error) is NETWORK_ERROR with requestMayHaveDispatched: false and never reaches fetch", async () => {
    let fetchCalls = 0;
    const service = new KVService({});
    const baseContext = createContext(async () => {
      fetchCalls++;
      return response(true, 200, { written: [...FIVE_KEYS], count: 5 });
    }, [], []);
    service.initialize({
      ...baseContext,
      invokeAny: () => {
        throw new Error("signing failed");
      },
    });

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta?.requestMayHaveDispatched).toBe(false);
    }
    expect(fetchCalls).toBe(0);
  });

  // Sol B1/B6c: a pre-fetch throw whose name/message says "timeout" must NOT
  // be reconciled by AccountService — it is deterministic (nothing was
  // dispatched), even though wrapError labels it TIMEOUT.
  test("a pre-fetch invokeAny TimeoutError throw is TIMEOUT with requestMayHaveDispatched: false and never reaches fetch", async () => {
    let fetchCalls = 0;
    const service = new KVService({});
    const baseContext = createContext(async () => {
      fetchCalls++;
      return response(true, 200, { written: [...FIVE_KEYS], count: 5 });
    }, [], []);
    service.initialize({
      ...baseContext,
      invokeAny: () => {
        const timeoutError = new Error("the operation timed out");
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      },
    });

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.TIMEOUT);
      expect(result.error.meta?.requestMayHaveDispatched).toBe(false);
    }
    expect(fetchCalls).toBe(0);
  });

  // Sol B2: `this.context.fetch` is a getter (context.ts:154-156) that can
  // itself throw (assertActive()) before any request is constructed or
  // handed to a transport. The flag must only be set AFTER that getter has
  // been evaluated, so this throw is deterministic — never reconciled.
  test("a context.fetch getter throw is NETWORK_ERROR with requestMayHaveDispatched: false and never dispatches", async () => {
    const service = new KVService({});
    const baseContext = createContext(async () => {
      throw new Error("fetch should never be invoked");
    }, [], []);
    const contextWithThrowingFetchGetter: IServiceContext = {
      ...baseContext,
      get fetch(): IServiceContext["fetch"] {
        throw new Error("context is no longer active");
      },
    };
    service.initialize(contextWithThrowingFetchGetter);

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta?.requestMayHaveDispatched).toBe(false);
    }
  });

  // Sol B3: a 2xx response whose body is not valid JSON must be classified
  // as the unconfirmed-2xx case with the FULL metadata block, not lose it by
  // falling through to the generic catch.
  test("a 2xx response whose body is not valid JSON is unconfirmed-2xx with full metadata", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        const res = response(true, 200, {});
        res.json = async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        };
        return res;
      }, [], [])
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
      expect(result.error.meta).toEqual({
        requestMayHaveDispatched: true,
        responseReceived: true,
        status: 200,
        outcome: "batch-unconfirmed",
      });
    }
  });

  // Sol B4: a deterministic 4xx whose body read rejects must stay
  // deterministic — it must NOT be relabeled NETWORK_ERROR with
  // requestMayHaveDispatched: true (which would make AccountService
  // reconcile a write that the node definitively rejected).
  test("a 400 response whose body read rejects stays a deterministic KV_WRITE_FAILED", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        const res = response(false, 400, "Bad Request");
        res.text = async () => {
          throw new Error("body stream already consumed");
        };
        return res;
      }, [], [])
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.KV_WRITE_FAILED);
      expect(result.error.meta).toEqual({ status: 400, statusText: "Error" });
      // Must not be misclassified into the ambiguous transport-failure shape.
      expect(result.error.meta?.requestMayHaveDispatched).toBeUndefined();
    }
  });

  // Non-blocking coverage gap noted in the TC-373 round-2 review: only the
  // deterministic-400 body-read-rejects branch was directly tested above.
  // An AMBIGUOUS 5xx (503 is a member of AccountService's
  // AMBIGUOUS_WRITE_STATUSES) whose body read also rejects must stay
  // KV_WRITE_FAILED with its real status, exactly like the 400 case — the
  // production code path is identical for both, but only the status
  // determines whether AccountService.registerBatch later reconciles it via
  // per-space puts.
  test("a 503 response whose body read rejects stays KV_WRITE_FAILED with its real status (ambiguous, DOES trigger reconciliation)", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () => {
        const res = response(false, 503, "Service Unavailable");
        res.text = async () => {
          throw new Error("body stream already consumed");
        };
        return res;
      }, [], [])
    );

    const result = await service.batchPut(fiveItems());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.KV_WRITE_FAILED);
      expect(result.error.meta).toEqual({ status: 503, statusText: "Error" });
      expect(result.error.meta?.requestMayHaveDispatched).toBeUndefined();
      // 503 is in AMBIGUOUS_WRITE_STATUSES (AccountService.ts), unlike 400 in
      // the sibling test above — this is the status that governs whether
      // AccountService.registerBatch reconciles via per-space puts.
    }
  });

  test("JSON values written via batchPut round-trip through get() as parsed objects (canonical read)", async () => {
    let batchPartType: string | undefined;
    const service = new KVService({ prefix: "app" });
    let calls = 0;
    service.initialize(
      createContext(async (_url, init) => {
        calls++;
        if (calls === 1) {
          // The batchPut call: capture the content-type actually assigned to
          // a plain JS object value.
          const form = init!.body as FormData;
          const part = form.get("app%2Fsettings.json") as Blob;
          batchPartType = part.type;
          return response(true, 200, { written: ["app/settings.json"], count: 1 });
        }
        // The subsequent get() call: the node echoes back the content-type it
        // stored for that blob — application/json for a JSON value, per
        // serializeBatchPutValue. Ordinary put() does not set this
        // explicitly, so this is the divergence TC-373 flagged as worth
        // testing explicitly rather than assuming byte-for-byte equivalence.
        const result = response(true, 200, { theme: "dark", version: 2 });
        result.headers = {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        };
        return result;
      }, [], [])
    );

    const written = await service.batchPut([
      { key: "settings.json", value: { theme: "dark", version: 2 } },
    ]);
    expect(written.ok).toBe(true);
    expect(batchPartType).toStartWith("application/json");

    const read = await service.get<{ theme: string; version: number }>("settings.json");
    expect(read.ok).toBe(true);
    if (read.ok) {
      // Canonical read: a parsed object, not the raw JSON text.
      expect(read.data.data).toEqual({ theme: "dark", version: 2 });
      expect(typeof read.data.data).toBe("object");
    }
  });
});

describe("KVService.createSignedReadUrl", () => {
  test("mints an absolute signed read URL using a kv/get invocation", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    let requestUrl: string | undefined;
    let requestInit: FetchRequestInit | undefined;

    const service = new KVService({});
    service.initialize(
      createContext(async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return response(true, 200, {
          url: "/signed/kv/ticket-123",
          ticketId: "ticket-123",
          expiresAt: "2026-05-13T12:00:00Z",
        });
      }, invokeCalls)
    );

    const result = await service.createSignedReadUrl("audio/conv-1/recording", {
      expiresInSeconds: 60,
      contentHash: "a".repeat(64),
      etag: '"blake3-test"',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        url: "https://node.tinycloud.xyz/signed/kv/ticket-123",
        relativeUrl: "/signed/kv/ticket-123",
        ticketId: "ticket-123",
        expiresAt: "2026-05-13T12:00:00Z",
      });
    }

    expect(invokeCalls).toEqual([
      {
        service: "kv",
        path: "audio/conv-1/recording",
        action: KVAction.GET,
      },
    ]);
    expect(requestUrl).toBe("https://node.tinycloud.xyz/signed/kv");
    expect(requestInit?.method).toBe("POST");
    expect(headerValue(requestInit?.headers, "authorization")).toBe(
      "Bearer signed-invocation"
    );
    expect(headerValue(requestInit?.headers, "content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      space: "tinycloud:pkh:eip155:1:0xabc:default",
      path: "audio/conv-1/recording",
      ttl_seconds: 60,
      content_hash: "a".repeat(64),
      etag: '"blake3-test"',
    });
  });

  test("applies prefixed KV paths", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    let requestInit: FetchRequestInit | undefined;

    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, {
          url: "/signed/kv/ticket-prefixed",
          ticketId: "ticket-prefixed",
          expiresAt: "2026-05-13T12:00:00Z",
        });
      }, invokeCalls)
    );

    const result = await service
      .withPrefix("/audio")
      .createSignedReadUrl("conv-1/recording", { expiresInSeconds: 120 });

    expect(result.ok).toBe(true);
    expect(invokeCalls[0]).toEqual({
      service: "kv",
      path: "/audio/conv-1/recording",
      action: KVAction.GET,
    });
    expect(JSON.parse(requestInit?.body as string)).toMatchObject({
      path: "/audio/conv-1/recording",
      ttl_seconds: 120,
    });
  });

  test("uses the default signed read URL expiry when omitted", async () => {
    let requestInit: FetchRequestInit | undefined;

    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, {
          url: "/signed/kv/ticket-default",
          ticketId: "ticket-default",
          expiresAt: "2026-05-13T12:00:00Z",
        });
      })
    );

    const result = await service.createSignedReadUrl("audio/conv-1/recording");

    expect(result.ok).toBe(true);
    expect(JSON.parse(requestInit?.body as string)).toMatchObject({
      path: "audio/conv-1/recording",
      ttl_seconds: Math.ceil(DEFAULT_SIGNED_READ_URL_EXPIRY_MS / 1000),
    });
  });

  test("returns structured auth errors from the node endpoint", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        response(false, 403, "signed URL scope is not authorized", "Forbidden")
      )
    );

    const result = await service.createSignedReadUrl("audio/conv-1/recording");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
      expect(result.error.message).toBe(
        'Failed to create signed read URL for key "audio/conv-1/recording": 403 - signed URL scope is not authorized',
      );
      expect(result.error.meta?.status).toBe(403);
    }
  });
});

describe("KVService.put serialization", () => {
  test("sends a string value as-is (no JSON wrapping)", async () => {
    let requestInit: FetchRequestInit | undefined;
    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, "");
      })
    );

    const result = await service.put("note", "hello-artifact");

    expect(result.ok).toBe(true);
    expect(requestInit?.body).toBe("hello-artifact");
  });

  test.each([401, 403])("keeps the status and KV upload authorization text for status %i", async (status) => {
    const serverMessage = "Unauthorized Action: vault/API_KEY / tinycloud.kv/put";
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        response(false, status, serverMessage, status === 401 ? "Unauthorized" : "Forbidden")
      )
    );

    const result = await service.put("vault/API_KEY", "value");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
    expect(result.error.message).toBe(`Failed to put key "vault/API_KEY": ${status} - ${serverMessage}`);
    expect(result.error.meta).toMatchObject({
      status,
      resource: "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/API_KEY",
      requiredAction: "tinycloud.kv/put",
    });
  });

  test("reports a full space as STORAGE_QUOTA_EXCEEDED with byte counts", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        response(
          false,
          402,
          "Storage quota exceeded. Used: 155744 bytes, Limit: 0 bytes",
          "Payment Required"
        )
      )
    );

    const result = await service.put("variables/API_URL", "value");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.STORAGE_QUOTA_EXCEEDED);
    expect(result.error.message).toBe(
      "TinyCloud storage is full, so this change was not saved. Reading still works. Free up space or upgrade your plan to save again."
    );
    expect(result.error.meta).toMatchObject({
      status: 402,
      key: "variables/API_URL",
      usedBytes: 155744,
      limitBytes: 0,
    });
  });

  test("reports a write larger than the remaining storage as STORAGE_LIMIT_REACHED", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        response(
          false,
          413,
          "Write exceeds remaining storage. Used: 900 bytes, Limit: 1000 bytes",
          "Payload Too Large"
        )
      )
    );

    const result = await service.put("files/photo.jpg", "x".repeat(200));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.STORAGE_LIMIT_REACHED);
    expect(result.error.message).toBe(
      "This change is larger than the TinyCloud storage you have left, so it was not saved. Reading still works. Free up space or upgrade your plan to save it."
    );
    expect(result.error.meta).toMatchObject({ status: 413, usedBytes: 900, limitBytes: 1000 });
  });

  test("a proxy's own 413 is a failed write, not a storage rejection", async () => {
    const service = new KVService({});
    service.initialize(
      createContext(async () =>
        response(false, 413, "<html><body>413 Request Entity Too Large</body></html>", "Payload Too Large")
      )
    );

    const result = await service.put("files/video.mp4", "x".repeat(200));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.KV_WRITE_FAILED);
    expect(result.error.meta?.status).toBe(413);
  });

  test("provides key and status when authorization response body is empty", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(false, 403, "", "Forbidden")));

    const result = await service.put("vault/record", "value");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
    expect(result.error.message).toBe('Failed to put key "vault/record": 403 - Forbidden');
    expect(result.error.meta?.status).toBe(403);
  });

  test("JSON-encodes plain objects", async () => {
    let requestInit: FetchRequestInit | undefined;
    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, "");
      })
    );

    const result = await service.put("settings", { theme: "dark" });

    expect(result.ok).toBe(true);
    expect(requestInit?.body).toBe(JSON.stringify({ theme: "dark" }));
  });

  test("sends binary (Uint8Array) values as raw bytes, not JSON", async () => {
    let requestInit: FetchRequestInit | undefined;
    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, "");
      })
    );

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
    const result = await service.put("img.png", bytes);

    expect(result.ok).toBe(true);
    expect(requestInit?.body).toBeInstanceOf(Blob);
    const blob = requestInit?.body as Blob;
    expect(blob.type).toBe("application/octet-stream");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test("sends Buffer values as raw bytes (not {type:Buffer,data:[...]})", async () => {
    let requestInit: FetchRequestInit | undefined;
    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, "");
      })
    );

    const buf = Buffer.from([0, 1, 2, 254, 255]);
    const result = await service.put("blob.bin", buf);

    expect(result.ok).toBe(true);
    expect(requestInit?.body).toBeInstanceOf(Blob);
    const blob = requestInit?.body as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 254, 255])
    );
    // Guard against the regression: must NOT serialize as JSON Buffer wrapper.
    const text = await blob.text();
    expect(text).not.toContain('"type":"Buffer"');
  });

  test("honors an explicit contentType for binary values", async () => {
    let requestInit: FetchRequestInit | undefined;
    const service = new KVService({});
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, "");
      })
    );

    const bytes = new Uint8Array([1, 2, 3]);
    const result = await service.put("img.png", bytes, {
      contentType: "image/png",
    });

    expect(result.ok).toBe(true);
    expect((requestInit?.body as Blob).type).toBe("image/png");
  });
});

describe("KVService.get binary", () => {
  function binaryResponse(bytes: Uint8Array): FetchResponse {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => {
        throw new Error("not json");
      },
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
      blob: async () => new Blob([bytes]),
    };
  }

  test("returns raw bytes as a Uint8Array when binary: true", async () => {
    // Bytes that are NOT valid UTF-8, to prove we don't go through text().
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 254, 1]);
    const service = new KVService({});
    service.initialize(createContext(async () => binaryResponse(bytes)));

    const result = await service.get("img.png", { binary: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data).toBeInstanceOf(Uint8Array);
      expect(result.data.data).toEqual(bytes);
    }
  });
});

describe("KVService bounded and conditional requests", () => {
  test("forwards node-enforced get and list limits and reports truncation", async () => {
    const requests: FetchRequestInit[] = [];
    const service = new KVService({});
    service.initialize(createContext(async (_url, init) => {
      requests.push(init ?? {});
      const listed = headerValue(init?.headers, "x-tinycloud-limit") !== undefined;
      const result = response(true, 200, listed ? ["a"] : "value");
      if (listed) {
        result.headers.get = (name: string) =>
          name.toLowerCase() === "x-tinycloud-truncated" ? "true" : name.toLowerCase() === "x-tinycloud-next-cursor" ? "cursor-2" : null;
      }
      return result;
    }));

    expect((await service.get("a", { binary: true, maxResponseBytes: 1024 })).ok).toBe(true);
    const listed = await service.list({ limit: 10, cursor: "cursor-1" });
    expect(listed).toEqual({ ok: true, data: { keys: ["a"], truncated: true, nextCursor: "cursor-2" } });
    expect(headerValue(requests[0]?.headers, "x-tinycloud-max-response-bytes")).toBe("1024");
    expect(headerValue(requests[1]?.headers, "x-tinycloud-limit")).toBe("10");
    expect(headerValue(requests[1]?.headers, "x-tinycloud-cursor")).toBe("cursor-1");
  });

  test("forwards create, replace, and conditional delete headers", async () => {
    const requests: FetchRequestInit[] = [];
    const service = new KVService({});
    service.initialize(createContext(async (_url, init) => {
      requests.push(init ?? {});
      const result = response(true, 200, "");
      result.headers.get = (name: string) =>
        name.toLowerCase() === "etag" ? '"blake3-current"' : null;
      return result;
    }));

    await service.put("new", "value", { ifNoneMatch: "*" });
    await service.put("existing", "value", { ifMatch: '"v1"' });
    const deleted = await service.delete("existing", { ifMatch: '"v2"' });
    expect(headerValue(requests[0]?.headers, "if-none-match")).toBe("*");
    expect(headerValue(requests[1]?.headers, "if-match")).toBe('"v1"');
    expect(headerValue(requests[2]?.headers, "if-match")).toBe('"v2"');
    expect(deleted).toMatchObject({
      ok: true,
      data: { headers: { etag: '"blake3-current"' } },
    });
  });

  test("classifies node limit and precondition responses", async () => {
    const service = new KVService({});
    let status = 413;
    service.initialize(createContext(async () => response(false, status, "failed")));
    const oversized = await service.get("large", { maxResponseBytes: 1 });
    expect(oversized).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_RESPONSE_TOO_LARGE } });
    status = 412;
    const put = await service.put("exists", "value", { ifNoneMatch: "*" });
    const deleted = await service.delete("changed", { ifMatch: '"old"' });
    expect(put).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_PRECONDITION_FAILED } });
    expect(deleted).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_PRECONDITION_FAILED } });
    status = 503;
    const putConflict = await service.put("changed", "value", { ifMatch: '"blake3-old"' });
    const deleteConflict = await service.delete("changed", { ifMatch: '"blake3-old"' });
    expect(putConflict).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_CONFLICT } });
    expect(deleteConflict).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_CONFLICT } });
  });
});

describe("KVService 404 classification (unhosted space vs missing key)", () => {
  function service(body: string) {
    const svc = new KVService({});
    svc.initialize(createContext(async () => response(false, 404, body)));
    return svc;
  }

  // An un-hosted space 404 must preserve status + the "Space not found" body so
  // the CLI/SDK can normalize it to SPACE_NOT_HOSTED (matching put/list/sql).
  for (const op of ["get", "head", "delete"] as const) {
    test(`${op}: unhosted-space 404 keeps status 404 + "Space not found" body`, async () => {
      const result = await service("404 - Space not found")[op]("k");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.KV_NOT_FOUND);
        expect(result.error.message).toMatch(/space not found/i);
        expect((result.error.meta as { status?: number } | undefined)?.status).toBe(404);
      }
    });

    test(`${op}: genuine missing key 404 is a plain KV_NOT_FOUND (no host signal)`, async () => {
      const result = await service("key not found")[op]("k");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.KV_NOT_FOUND);
        expect(result.error.message).toBe("Key not found: k");
        expect(result.error.message).not.toMatch(/space not found/i);
      }
    });
  }
});

describe("KVService authorization responses", () => {
  const path = "vault/secrets/API_KEY";
  const canonicalResource = `tinycloud:pkh:eip155:1:0xabc:default/kv/${path}`;
  const operations = [
    { name: "get", action: KVAction.GET, run: (service: KVService) => service.get(path) },
    { name: "put", action: KVAction.PUT, run: (service: KVService) => service.put(path, "value") },
    { name: "list", action: KVAction.LIST, run: (service: KVService) => service.list({ prefix: "vault/secrets", path: "API_KEY" }) },
    { name: "head", action: KVAction.HEAD, run: (service: KVService) => service.head(path) },
    { name: "delete", action: KVAction.DELETE, run: (service: KVService) => service.delete(path) },
  ];

  for (const operation of operations) {
    test.each([401, 403])(`${operation.name}: status %i preserves valid capability and authorization`, async (status) => {
      const body = `Unauthorized Action: ${path} / ${operation.action}`;
      const service = new KVService({});
      service.initialize(createContext(async () => response(false, status, body)));

      const result = await operation.run(service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
      expect(result.error.meta?.status).toBe(status);
      expect(authorizationVerdictOf(result.error)).toBe(status === 401 ? "unauthenticated" : "forbidden");
      expect(validatedCapabilityOf(result.error)).toEqual({
        resource: canonicalResource,
        requiredAction: operation.action,
      });
    });

    test(`${operation.name}: mismatched server capability cannot become grant advice`, async () => {
      const service = new KVService({});
      service.initialize(createContext(async () =>
        response(false, 403, `Unauthorized Action: vault/other / ${operation.action}`)
      ));

      const result = await operation.run(service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
      expect(result.error.meta?.status).toBe(403);
      expect(result.error.meta?.resource).toBeUndefined();
      expect(validatedCapabilityOf(result.error)).toBeUndefined();
    });

    test(`${operation.name}: unreadable 403 body retains typed authorization status without inventing a capability`, async () => {
      const service = new KVService({});
      service.initialize(createContext(async () => ({
        ...response(false, 403, "", "Forbidden"),
        text: async () => { throw new Error("body stream failed"); },
      })));

      const result = await operation.run(service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
      expect(result.error.meta?.status).toBe(403);
      expect(authorizationVerdictOf(result.error)).toBe("forbidden");
      expect(validatedCapabilityOf(result.error)).toBeUndefined();
    });
  }

  test.each([401, 403])("get: full canonical node resource at status %i maps to the requested capability", async (status) => {
    const service = new KVService({});
    service.initialize(createContext(async () =>
      response(false, status, `Unauthorized Action: ${canonicalResource} / ${KVAction.GET}`)
    ));
    const result = await service.get(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.meta?.status).toBe(status);
    expect(validatedCapabilityOf(result.error)).toEqual({
      resource: canonicalResource,
      requiredAction: KVAction.GET,
    });
  });

  test("get: a full node resource for another space cannot become grant advice", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () =>
      response(false, 403, `Unauthorized Action: tinycloud:pkh:eip155:1:0xdef:default/kv/${path} / ${KVAction.GET}`)
    ));
    const result = await service.get(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.meta?.status).toBe(403);
    expect(validatedCapabilityOf(result.error)).toBeUndefined();
  });

  test.each([
    ["URL resource", "https://attacker.example/grant", KVAction.PUT],
    ["fragment resource", "vault/secrets/API_KEY#all", KVAction.PUT],
    ["shell interpolation", "vault/${HOME}", KVAction.PUT],
    ["invalid action", path, "tinycloud.kv/put;curl"],
    ["action suffix", path, "tinycloud.kv/put/anything"],
    ["wrong service action", path, "tinycloud.sql/write"],
  ])("put: server %s is never promoted to capability metadata", async (_kind, resource, action) => {
    const service = new KVService({});
    service.initialize(createContext(async () =>
      response(false, 403, `Unauthorized Action: ${resource} / ${action}`)
    ));

    const result = await service.put(path, "value");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.meta?.status).toBe(403);
    expect(result.error.meta?.resource).toBeUndefined();
    expect(result.error.meta?.requiredAction).toBeUndefined();
    expect(validatedCapabilityOf(result.error)).toBeUndefined();
  });

  test.each([401, 403])("get: a matching structured hint gives the same canonical capability as an equivalent text denial at status %i", async (status) => {
    const permissionHint = {
      service: "tinycloud.kv",
      space: "tinycloud:pkh:eip155:1:0xabc:default",
      path,
      actions: [KVAction.GET],
    };
    const structured = new KVService({});
    structured.initialize(createContext(async () => response(false, status, {
      permissionHint,
      resource: "tinycloud:pkh:eip155:1:0xdef:other/kv/vault/secrets/OTHER_KEY",
    })));
    const text = new KVService({});
    text.initialize(createContext(async () =>
      response(false, status, `Unauthorized Action: ${path} / ${KVAction.GET}`)
    ));

    const [structuredResult, textResult] = await Promise.all([structured.get(path), text.get(path)]);
    expect(structuredResult.ok).toBe(false);
    expect(textResult.ok).toBe(false);
    if (structuredResult.ok || textResult.ok) return;
    expect(structuredResult.error.meta?.permissionHint).toEqual(permissionHint);
    expect(structuredResult.error.meta?.status).toBe(status);
    expect(structuredResult.error.meta?.resource).toBe(canonicalResource);
    expect(structuredResult.error.meta?.requiredAction).toBe(KVAction.GET);
    expect(validatedCapabilityOf(structuredResult.error)).toEqual(validatedCapabilityOf(textResult.error));
  });

  test.each([
    ["path", { path: "vault/secrets/OTHER_KEY" }],
    ["space", { space: "tinycloud:pkh:eip155:1:0xdef:default" }],
    ["service", { service: "tinycloud.sql" }],
    ["action", { actions: [KVAction.PUT] }],
  ])("get: a structured hint for a different %s never becomes grant advice", async (_field, change) => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(false, 403, {
      permissionHint: {
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0xabc:default",
        path,
        actions: [KVAction.GET],
        ...change,
      },
    })));
    const result = await service.get(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.meta?.status).toBe(403);
    expect(result.error.meta?.permissionHint).toBeUndefined();
    expect(result.error.meta?.resource).toBeUndefined();
    expect(result.error.meta?.requiredAction).toBeUndefined();
    expect(validatedCapabilityOf(result.error)).toBeUndefined();
  });
});

describe("KVService.changes (tinycloud.kv/sync)", () => {
  const page: KVChangesResponse = {
    changes: [
      { key: "notes/a", deleted: false, etag: '"blake3-aa"', metadata: { "content-type": "text/plain" } },
      { key: "notes/b", deleted: true },
    ],
    more: true,
    cursor: "cursor-2",
    source: { nodeDid: "did:key:node", space: "tinycloud:pkh:eip155:1:0xabc:default", prefix: "notes/" },
    authority: { notBefore: null, expiresAt: "2026-10-05T11:12:08Z", retainUntil: null },
  };

  test("invokes kv/sync on the prefix with limit, cursor and retention headers", async () => {
    const requests: FetchRequestInit[] = [];
    const invocations: Array<{ service: string; path: string; action: string }> = [];
    const service = new KVService({ prefix: "ignored-config-prefix" });
    service.initialize(createContext(async (_url, init) => {
      requests.push(init ?? {});
      return response(true, 200, page);
    }, invocations));

    const result = await service.changes({
      prefix: "notes/",
      cursor: "cursor-1",
      limit: 25,
      retentionGrant: "bafyretain",
    });

    expect(result).toEqual({ ok: true, data: page });
    expect(invocations).toEqual([{ service: "kv", path: "notes/", action: KVAction.SYNC }]);
    expect(headerValue(requests[0]?.headers, "x-tinycloud-limit")).toBe("25");
    expect(headerValue(requests[0]?.headers, "x-tinycloud-cursor")).toBe("cursor-1");
    expect(headerValue(requests[0]?.headers, "x-tinycloud-retention-grant")).toBe("bafyretain");
  });

  test("a bootstrap request sends no cursor, limit or retention header", async () => {
    const requests: FetchRequestInit[] = [];
    const service = new KVService({});
    service.initialize(createContext(async (_url, init) => {
      requests.push(init ?? {});
      return response(true, 200, page);
    }));

    expect((await service.changes({ prefix: "notes/" })).ok).toBe(true);
    for (const name of ["x-tinycloud-limit", "x-tinycloud-cursor", "x-tinycloud-retention-grant"]) {
      expect(headerValue(requests[0]?.headers, name)).toBeUndefined();
    }
  });

  test.each([
    ["an empty prefix", { prefix: "" }],
    ["a zero limit", { prefix: "notes/", limit: 0 }],
    ["a limit above 1000", { prefix: "notes/", limit: 1001 }],
    ["a fractional limit", { prefix: "notes/", limit: 1.5 }],
  ])("rejects %s before any request", async (_label, options) => {
    let fetched = false;
    const service = new KVService({});
    service.initialize(createContext(async () => {
      fetched = true;
      return response(true, 200, page);
    }));

    const result = await service.changes(options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(fetched).toBe(false);
  });

  test.each(["cursor-invalid", "position-unknown"])("maps 410 %s to KV_SYNC_RESET_REQUIRED with its reason", async (reason) => {
    const service = new KVService({});
    service.initialize(createContext(async () =>
      response(false, 410, { error: { code: "RESET_REQUIRED", reason } })
    ));

    const result = await service.changes({ prefix: "notes/", cursor: "stale" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.KV_SYNC_RESET_REQUIRED);
    expect(result.error.meta?.reason).toBe(reason);
    expect(result.error.meta?.status).toBe(410);
  });

  test.each([
    ["delegation-revoked: bafyleaf", ErrorCodes.AUTH_DELEGATION_REVOKED],
    ["Invalid invocation: delegation-ancestor-revoked: ancestor=bafyroot invoked=bafyleaf", ErrorCodes.AUTH_DELEGATION_ANCESTOR_REVOKED],
    ["delegation-ancestor-revoked: ancestor=bafyreiroot invoked=bafyreileaf", ErrorCodes.AUTH_DELEGATION_ANCESTOR_REVOKED],
  ])("maps 401 %s to a typed revocation code", async (body, code) => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(false, 401, body)));

    const result = await service.changes({ prefix: "notes/" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.error.meta?.status).toBe(401);
    expect(authorizationVerdictOf(result.error)).toBe("unauthenticated");
  });

  test.each([
    ["Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:default/kv/notes/delegation-revoked/ / tinycloud.kv/sync", "notes/delegation-revoked/"],
    ["Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:default/kv/x/delegation-ancestor-revoked: ancestor=a invoked=b / tinycloud.kv/sync", "x/delegation-ancestor-revoked: ancestor=a invoked=b"],
    ["delegation-revoked: bafyleaf (while reading notes/x)", "notes/"],
  ])("maps a 401 that only mentions a revocation (%s) to AUTH_UNAUTHORIZED", async (body, prefix) => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(false, 401, body)));

    const result = await service.changes({ prefix });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
    expect(result.error.meta?.status).toBe(401);
  });

  test("a missing sync grant stays AUTH_UNAUTHORIZED", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () =>
      response(false, 401, "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:default/kv/notes / tinycloud.kv/sync")
    ));

    const result = await service.changes({ prefix: "notes" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
    expect(validatedCapabilityOf(result.error)).toEqual({
      resource: "tinycloud:pkh:eip155:1:0xabc:default/kv/notes",
      requiredAction: KVAction.SYNC,
    });
  });

  test("maps a refused retention grant to KV_RETENTION_GRANT_REFUSED", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () =>
      response(false, 403, { error: { code: "RETENTION_GRANT_REFUSED", reason: "retention-grant-expired" } })
    ));

    const result = await service.changes({ prefix: "notes/", retentionGrant: "bafyretain" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.KV_RETENTION_GRANT_REFUSED);
    expect(result.error.meta?.reason).toBe("retention-grant-expired");
  });

  test.each([
    ["a list body", ["notes/a"]],
    ["a live change without an etag", { ...page, changes: [{ key: "notes/a", deleted: false, metadata: {} }] }],
    ["a missing authority", { ...page, authority: undefined }],
  ])("rejects %s as a malformed page", async (_label, body) => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, body)));

    const result = await service.changes({ prefix: "notes/" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
  });

  test("a prefixed view follows everything under its prefix and returns relative keys", async () => {
    const invocations: Array<{ service: string; path: string; action: string }> = [];
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, page), invocations));

    const result = await service.withPrefix("notes").changes({ limit: 10 });

    expect(invocations).toEqual([{ service: "kv", path: "notes/", action: KVAction.SYNC }]);
    expect(result.ok && result.data.changes.map((change) => change.key)).toEqual(["a", "b"]);
    expect(result.ok && result.data.source.prefix).toBe("notes/");
  });

  test.each(["", "/"])("a prefixed view with prefix %j is refused before any request", async (prefix) => {
    let fetched = false;
    const service = new KVService({});
    service.initialize(createContext(async () => {
      fetched = true;
      return response(true, 200, page);
    }));

    const result = await service.withPrefix(prefix).changes();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(fetched).toBe(false);
  });

  test("missing options is an INVALID_INPUT result, not a thrown TypeError", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, page)));
    // The call shape of a plain-JS caller; TypeScript rejects the missing argument.
    const changesFromJs = service.changes.bind(service) as (
      options?: KVChangesOptions
    ) => Promise<Result<KVChangesResponse>>;

    const result = await changesFromJs();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
  });

  test("accepts a page larger than limit and an empty page with more: true", async () => {
    const many = Array.from({ length: 3 }, (_, index) => ({ key: `notes/batch-${index}`, deleted: true as const }));
    const bodies = [
      { ...page, changes: many, more: false },
      { ...page, changes: [], more: true },
    ];
    const service = new KVService({});
    service.initialize(createContext(async () => response(true, 200, bodies.shift())));

    const oversized = await service.changes({ prefix: "notes/", limit: 1 });
    expect(oversized.ok && oversized.data.changes).toEqual(many);
    const empty = await service.changes({ prefix: "notes/", limit: 1 });
    expect(empty.ok && empty.data).toMatchObject({ changes: [], more: true, cursor: page.cursor });
  });

  test("a 404 for an unhosted space keeps the KV not-found classification", async () => {
    const service = new KVService({});
    service.initialize(createContext(async () => response(false, 404, "Space not found")));

    const result = await service.changes({ prefix: "notes/" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCodes.KV_NOT_FOUND);
    expect(result.error.meta?.status).toBe(404);
  });

  describe("an error body that never completes", () => {
    /**
     * Error headers arrive, then the body stalls until the request is
     * cancelled. The optional callback simulates a caller abort after the body
     * read starts; without it, the body remains pending until the request
     * timeout aborts the signal.
     */
    function stalledError(status: number, cancel?: () => void): IServiceContext["fetch"] {
      return async (_url, init) => {
        const stalled = response(false, status, "");
        stalled.text = () => new Promise<string>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (cancel) queueMicrotask(cancel);
        });
        return stalled;
      };
    }

    test.each([401, 410, 500])("%i ends with TIMEOUT when the timeout elapses", async (status) => {
      const service = new KVService({});
      service.initialize(createContext(stalledError(status)));

      const result = await service.changes({ prefix: "notes/", timeout: 20 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCodes.TIMEOUT);
    });

    test.each([401, 410, 500])("%i ends with ABORTED when the caller aborts", async (status) => {
      const controller = new AbortController();
      const service = new KVService({});
      service.initialize(createContext(stalledError(status, () => controller.abort())));

      const result = await service.changes({ prefix: "notes/", signal: controller.signal });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCodes.ABORTED);
    });
  });
});
test("KVService uses its existing network path when read-through is unset", async () => {
  let fetchCount = 0;
  const service = new KVService({});
  service.initialize(createContext(async () => {
    fetchCount += 1;
    return response(true, 200, "network value");
  }));

  const result = await service.get("key", { raw: true });

  expect(result).toMatchObject({ ok: true, data: { data: "network value" } });
  expect(fetchCount).toBe(1);
});
test("network-only reads report their settled outcome without reading the replica", async () => {
  let fetchCount = 0;
  let localReadCount = 0;
  const observations: Array<{ op: string; space: string; path: string; reason: string; outcome: string; latencyMs: number; fetchCountAtObservation: number }> = [];
  const service = new KVService({});
  service.initialize(createContext(async () => {
    fetchCount += 1;
    return fetchCount === 1
      ? response(true, 200, "network value")
      : response(true, 200, ["notes/a"]);
  }));
  service.setReadThrough({
    get: async () => {
      localReadCount += 1;
      throw new Error("network-only get read the replica");
    },
    list: async () => {
      localReadCount += 1;
      throw new Error("network-only list read the replica");
    },
    write: async () => {
      throw new Error("unexpected write");
    },
    observeNetworkRequested: (observation) => {
      observations.push({ ...observation, fetchCountAtObservation: fetchCount });
      throw new Error("best-effort observer failure");
    },
  });

  const get = await service.get("key", { source: "network", raw: true });
  const list = await service.list({ source: "network", prefix: "notes" });

  expect(get).toMatchObject({ ok: true, data: { data: "network value" } });
  expect(list).toMatchObject({ ok: true, data: { keys: ["notes/a"] } });
  expect(fetchCount).toBe(2);
  expect(localReadCount).toBe(0);
  expect(observations).toEqual([
    {
      op: "get",
      space: "tinycloud:pkh:eip155:1:0xabc:default",
      path: "key",
      reason: "NETWORK_REQUESTED",
      outcome: "found",
      latencyMs: expect.any(Number),
      fetchCountAtObservation: 1,
    },
    {
      op: "list",
      space: "tinycloud:pkh:eip155:1:0xabc:default",
      path: "notes",
      reason: "NETWORK_REQUESTED",
      outcome: "found",
      latencyMs: expect.any(Number),
      fetchCountAtObservation: 2,
    },
  ]);
});

test("network-only read outcomes include not-found and error", async () => {
  const observations: Array<{ op: string; outcome: string; latencyMs: number }> = [];
  const service = new KVService({});
  let fetchCount = 0;
  service.initialize(createContext(async () => {
    fetchCount++;
    return fetchCount === 1
      ? response(false, 404, "Key not found: missing")
      : response(false, 500, "server failure");
  }));
  service.setReadThrough({
    get: async () => { throw new Error("network-only get read the replica"); },
    list: async () => { throw new Error("network-only list read the replica"); },
    write: async () => { throw new Error("unexpected write"); },
    observeNetworkRequested: ({ op, outcome, latencyMs }) => observations.push({ op, outcome, latencyMs }),
  });

  const missing = await service.get("missing", { source: "network" });
  const failedList = await service.list({ source: "network", prefix: "notes" });

  expect(missing).toMatchObject({ ok: false, error: { code: ErrorCodes.KV_NOT_FOUND } });
  expect(failedList.ok).toBe(false);
  expect(observations.map(({ op, outcome }) => [op, outcome])).toEqual([
    ["get", "not_found"],
    ["list", "error"],
  ]);
  expect(observations.every(({ latencyMs }) => latencyMs >= 0)).toBe(true);
});
