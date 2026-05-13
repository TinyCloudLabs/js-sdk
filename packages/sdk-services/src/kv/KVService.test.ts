import { describe, expect, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
  ServiceHeaders,
} from "../types";
import { ErrorCodes } from "../types";
import { KVService } from "./KVService";
import {
  DEFAULT_SIGNED_READ_URL_EXPIRES_IN_SECONDS,
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
      ).buffer,
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
  invokeCalls: Array<{ service: string; path: string; action: string }> = []
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
  };
}

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
      ttl_seconds: DEFAULT_SIGNED_READ_URL_EXPIRES_IN_SECONDS,
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
