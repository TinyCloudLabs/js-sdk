import { describe, expect, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
  InvokeAnyEntry,
  ServiceHeaders,
} from "../types";
import { ErrorCodes } from "../types";
import { KVService } from "./KVService";
import {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  KVAction,
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
    expect(invokeAnyCalls).toHaveLength(0);
    expect(fetches).toBe(0);
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
      expect(result.error.message).toBe("signed URL scope is not authorized");
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
