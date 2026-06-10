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
