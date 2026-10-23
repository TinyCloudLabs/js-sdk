import { describe, expect, test } from "bun:test";
import type {
  FetchRequestInit,
  FetchResponse,
  IServiceContext,
} from "../types";
import { ErrorCodes } from "../types";
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

describe("DuckDbService 413 request vs response classification", () => {
  function serviceAnswering(body: string): DuckDbService {
    const service = new DuckDbService();
    service.initialize(
      createContext(
        async () => response(false, 413, body, "Payload Too Large"),
        [],
      ),
    );
    return service;
  }

  test("coded request 413 maps to DUCKDB_REQUEST_TOO_LARGE with split guidance", async () => {
    const service = serviceAnswering(
      "duckdb_request_too_large: JSON body exceeds complete envelope limit (limit 1024 bytes)",
    );

    const result = await service.batch([{ sql: "INSERT INTO notes VALUES (1)" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
      expect(result.error.message).toBe(
        "DuckDB batch failed: request is too large (the node's limit is 1024 bytes). Split the batch into smaller requests.",
      );
    }
  });

  test("coded request 413 with a node limit clause names the node's limit in the message", async () => {
    const service = serviceAnswering(
      "duckdb_request_too_large: JSON body exceeds complete envelope limit (limit 4096 bytes)",
    );

    const result = await service.batch([{ sql: "INSERT INTO notes VALUES (1)" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        "DuckDB batch failed: request is too large (the node's limit is 4096 bytes). " +
          "Split the batch into smaller requests.",
      );
    }
  });

  test("coded response 413 stays DUCKDB_RESPONSE_TOO_LARGE even for a write statement", async () => {
    const service = serviceAnswering(
      "duckdb_response_too_large: Response too large: 2048 bytes (limit 1024 bytes)",
    );

    const result = await service.execute("INSERT INTO notes VALUES (1)");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE);
    }
  });

  test("uncoded 413 on a write statement maps to DUCKDB_REQUEST_TOO_LARGE", async () => {
    const service = serviceAnswering("JSON body exceeds complete envelope limit");

    const result = await service.batch([{ sql: "INSERT INTO notes VALUES (1)" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
    }
  });

  test("uncoded 413 on a read statement maps to DUCKDB_RESPONSE_TOO_LARGE", async () => {
    const service = serviceAnswering("Response too large: 2048 bytes");

    const result = await service.query("SELECT * FROM big");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE);
    }
  });

  test("uncoded 413 on a WITH statement uses the envelope text to pick request", async () => {
    const service = serviceAnswering("JSON body exceeds complete envelope limit");

    const result = await service.execute(
      "WITH src AS (SELECT 1 AS id) INSERT INTO notes (id) SELECT id FROM src",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
    }
  });

  test("uncoded 413 on a WITH statement without envelope text stays a response error", async () => {
    const service = serviceAnswering("Response too large: 2048 bytes");

    const result = await service.execute("WITH src AS (SELECT 1 AS id) SELECT id FROM src");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE);
    }
  });

  test("coded request 413 on a read query maps to DUCKDB_REQUEST_TOO_LARGE, the prefix beats the action", async () => {
    const service = serviceAnswering("duckdb_request_too_large: JSON body exceeds complete envelope limit");

    const result = await service.query("SELECT * FROM big");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
    }
  });

  test("bare request code 413 with no colon maps to DUCKDB_REQUEST_TOO_LARGE", async () => {
    const service = serviceAnswering("duckdb_request_too_large");

    const result = await service.query("SELECT * FROM big");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
    }
  });

  test("generic request_too_large code is ignored, so a read query stays DUCKDB_RESPONSE_TOO_LARGE", async () => {
    const service = serviceAnswering("request_too_large: JSON body exceeds complete envelope limit");

    const result = await service.query("SELECT * FROM big");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE);
    }
  });

  test("coded request prefix beats response text on ambiguous WITH and EXPLAIN executes", async () => {
    const service = serviceAnswering("duckdb_request_too_large: Response too large: 2048 bytes");

    const withResult = await service.execute("WITH src AS (SELECT 1 AS id) SELECT id FROM src");
    const explainResult = await service.execute("EXPLAIN SELECT 1");

    expect(withResult.ok).toBe(false);
    if (!withResult.ok) {
      expect(withResult.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
    }
    expect(explainResult.ok).toBe(false);
    if (!explainResult.ok) {
      expect(explainResult.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
    }
  });

  test("coded response prefix beats envelope text on an ambiguous WITH execute", async () => {
    const service = serviceAnswering("duckdb_response_too_large: JSON body exceeds complete envelope limit");

    const result = await service.execute(
      "WITH src AS (SELECT 1 AS id) INSERT INTO notes (id) SELECT id FROM src",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE);
    }
  });

  test("uncoded 413 with a node limit clause does not echo the limit in the message", async () => {
    const service = serviceAnswering("JSON body exceeds complete envelope limit (limit 1024 bytes)");

    const result = await service.batch([{ sql: "INSERT INTO notes VALUES (1)" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DUCKDB_REQUEST_TOO_LARGE);
      expect(result.error.message).not.toMatch(/1024/);
    }
  });

  test("coded request 413 without a limit clause adds no digits to the message", async () => {
    const service = serviceAnswering("duckdb_request_too_large: JSON body exceeds complete envelope limit");

    const result = await service.batch([{ sql: "INSERT INTO notes VALUES (1)" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toMatch(/\d/);
    }
  });
});
