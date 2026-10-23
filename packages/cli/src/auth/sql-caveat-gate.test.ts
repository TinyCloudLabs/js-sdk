import { describe, expect, test } from "bun:test";
import { assertHostSupportsSqlDelegatedCaveats, needsSqlDelegatedCaveats } from "./sql-caveat-gate.js";

const HOST = "https://node.example.test";
const FEATURE = "sql-delegated-caveats-v1";

const sql = (caveats?: Record<string, unknown>[]) => ({ service: "tinycloud.sql", ...(caveats === undefined ? {} : { caveats }) });
const profile = { mode: "constrained-statements", readOnly: true, statements: [{ name: "get", sql: "SELECT 1", fixedParams: [] }] };

function infoFetch(features: unknown, requests: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ features }), { status: 200 });
  }) as typeof fetch;
}

describe("needsSqlDelegatedCaveats", () => {
  test.each([
    ["delegated form", [sql([{ tables: ["Notes"] }])], true],
    ["two empty-only entries", [sql([{}, {}])], true],
    ["no caveats", [sql()], false],
    ["[]", [sql([])], false],
    ["[{}]", [sql([{}])], false],
    ["a profile", [sql([profile])], false],
    ["delegated-looking caveat on another service", [{ service: "tinycloud.kv", caveats: [{ tables: ["a"] }] }], false],
  ] as const)("%s", (_label, permissions, expected) => {
    expect(needsSqlDelegatedCaveats(permissions)).toBe(expected);
  });
});

describe("assertHostSupportsSqlDelegatedCaveats", () => {
  test("a request that needs no feature never touches the network", async () => {
    const requests: string[] = [];
    await assertHostSupportsSqlDelegatedCaveats(HOST, [sql(), sql([{}]), sql([profile])], infoFetch([], requests));
    expect(requests).toEqual([]);
  });

  test("refuses when the node does not list the feature", async () => {
    const requests: string[] = [];
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, [sql([{ tables: ["a"] }])], infoFetch(["sql"], requests)))
      .rejects.toMatchObject({ code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED" });
    expect(requests).toEqual([`${HOST}/info`]);
  });

  test("passes when the node lists the feature", async () => {
    await assertHostSupportsSqlDelegatedCaveats(`${HOST}/`, [sql([{ readOnly: true }])], infoFetch(["sql", FEATURE], []));
    await assertHostSupportsSqlDelegatedCaveats(HOST, [sql([{}, {}])], infoFetch([FEATURE], []));
  });

  test("fails closed when the features cannot be read", async () => {
    const permissions = [sql([{ tables: ["a"] }])];
    const refused = { code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED" };
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, permissions, (async () => { throw new Error("offline"); }) as typeof fetch))
      .rejects.toMatchObject(refused);
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, permissions, (async () => new Response("no", { status: 500 })) as typeof fetch))
      .rejects.toMatchObject(refused);
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, permissions, (async () => new Response("null", { status: 200 })) as typeof fetch))
      .rejects.toMatchObject(refused);
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, permissions, infoFetch("sql-delegated-caveats-v1", [])))
      .rejects.toMatchObject(refused);
  });

  test("a node that never answers is refused once the timeout aborts the read", async () => {
    let received: AbortSignal | null | undefined;
    const stalled = ((_input: unknown, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      received = init?.signal;
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      return promise;
    }) as typeof fetch;
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, [sql([{ tables: ["a"] }])], stalled, 5))
      .rejects.toMatchObject({ code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED" });
    expect(received?.aborted).toBe(true);
  });

  test("a fetch that rejects with an AbortError is refused", async () => {
    const aborted = (async () => { throw new DOMException("The operation was aborted.", "AbortError"); }) as typeof fetch;
    await expect(assertHostSupportsSqlDelegatedCaveats(HOST, [sql([{}, {}])], aborted))
      .rejects.toMatchObject({ code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED" });
  });

  test("the read carries a 5 s abort signal by default", async () => {
    let signal: AbortSignal | null | undefined;
    const capturing = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ features: [FEATURE] }), { status: 200 });
    }) as typeof fetch;
    await assertHostSupportsSqlDelegatedCaveats(HOST, [sql([{ tables: ["a"] }])], capturing);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});
