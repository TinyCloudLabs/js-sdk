import { describe, expect, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
} from "../types";
import { DuckDbService } from "./DuckDbService";
import { DuckDbAction } from "./types";

function response(
  ok: boolean,
  status: number,
  body: unknown,
  statusText = ok ? "OK" : "Error",
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
        typeof body === "string" ? body : JSON.stringify(body),
      ).buffer as ArrayBuffer,
    blob: async () =>
      new Blob([typeof body === "string" ? body : JSON.stringify(body)]),
  };
}

function createContext(
  fetchImpl: IServiceContext["fetch"],
  invokeCalls: Array<{ service: string; path: string; action: string }>,
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
      };
    },
    invokeAny: (_session, entries) => {
      return {
        Authorization: "Bearer signed-multi-invocation",
      };
    },
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

// TC-114: the client must mint the ability the node actually dispatches, not
// the literal method name. `describe` is authorized as a read and
// `executeStatement` as a write (see DuckDbService for node file:line
// grounding), so a narrowly-delegated read+write session works.
describe("DuckDbService permissions (TC-114)", () => {
  test("describe signs with read permission", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    let requestInit: FetchRequestInit | undefined;

    const service = new DuckDbService();
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, { tables: [] });
      }, invokeCalls),
    );

    const result = await service.describeDb("default");

    expect(result.ok).toBe(true);
    expect(invokeCalls).toEqual([
      { service: "duckdb", path: "default", action: DuckDbAction.READ },
    ]);
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      action: "describe",
    });
  });

  test("executeStatement signs with write permission", async () => {
    const invokeCalls: Array<{ service: string; path: string; action: string }> = [];
    let requestInit: FetchRequestInit | undefined;

    const service = new DuckDbService();
    service.initialize(
      createContext(async (_url, init) => {
        requestInit = init;
        return response(true, 200, { columns: [], rows: [], rowCount: 0 });
      }, invokeCalls),
    );

    const result = await service.executeStatementOnDb("default", "insert_row", [
      "hello",
    ]);

    expect(result.ok).toBe(true);
    expect(invokeCalls).toEqual([
      { service: "duckdb", path: "default", action: DuckDbAction.WRITE },
    ]);
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      action: "executeStatement",
      name: "insert_row",
      params: ["hello"],
    });
  });
});
