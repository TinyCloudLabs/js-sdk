import { beforeEach, describe, expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { KVService } from "./kv/KVService";
import { SQLService } from "./sql/SQLService";
import type { FetchRequestInit, ServiceHeaders } from "./types";

// A fake node that mirrors tinycloud-node's replay protection: every /invoke is
// recorded by its invocation (the Authorization header) before the handler
// runs, and a repeat of the same invocation is answered 409 whatever the first
// answer was. The first `busyFirst` requests are answered 503 sql_busy (after
// the record, like the real node), the rest succeed.

const BUSY = "sql_busy: begin: database is locked";

let minted = 0;
let seen: Set<string>;
let invocations: string[];
let busyFirst: number;

const authorizationOf = (init?: FetchRequestInit): string => {
  const headers: ServiceHeaders | undefined = init?.headers;
  return (headers as Record<string, string>).Authorization;
};

const fakeNode = async (url: string, init?: FetchRequestInit) => {
  const cid = authorizationOf(init);
  invocations.push(cid);
  if (seen.has(cid)) return new Response("duplicate invocation", { status: 409 });
  seen.add(cid);
  if (invocations.length <= busyFirst) {
    return new Response(BUSY, { status: 503, headers: { "retry-after": "0" } });
  }
  return url.endsWith("/invoke") && init?.method === "POST"
    ? new Response(JSON.stringify({ rowsAffected: 1, changes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    : new Response("", { status: 404 });
};

function contextWith(retry?: { maxAttempts: number }) {
  const context = new ServiceContext({
    // A fresh signed invocation (new CID) on every call, as the session signer does.
    invoke: () => ({ Authorization: `invocation-${++minted}` }),
    fetch: fakeNode as never,
    hosts: ["https://node.test"],
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafytest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    retryPolicy: retry,
  });
  return context;
}

describe("retry against a node that enforces invocation replay", () => {
  beforeEach(() => {
    minted = 0;
    seen = new Set();
    invocations = [];
    busyFirst = 1;
  });

  test("kv.put: busy then OK succeeds, each attempt carrying a distinct invocation", async () => {
    const context = contextWith();
    const kv = new KVService({});
    kv.initialize(context);
    const result = await kv.put("note", "hello");
    expect(result.ok).toBe(true);
    expect(invocations).toHaveLength(2);
    expect(new Set(invocations).size).toBe(2);
  });

  test("sql.execute: busy then OK succeeds, each attempt carrying a distinct invocation", async () => {
    const context = contextWith();
    const sql = new SQLService({});
    sql.initialize(context);
    const result = await sql.db("main").execute("INSERT INTO notes VALUES (1)");
    expect(result.ok).toBe(true);
    expect(invocations).toHaveLength(2);
    expect(new Set(invocations).size).toBe(2);
  });

  test("the node really does reject a repeated invocation", async () => {
    const init = { method: "POST", headers: { Authorization: "same" } };
    expect((await fakeNode("https://node.test/invoke", init)).status).toBe(503);
    expect((await fakeNode("https://node.test/invoke", init)).status).toBe(409);
  });

  test("a persistently busy node still surfaces the typed NODE_BUSY, never a 409", async () => {
    busyFirst = 99;
    const context = contextWith({ maxAttempts: 3 });
    const kv = new KVService({});
    kv.initialize(context);
    const result = await kv.put("note", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NODE_BUSY");
    expect(invocations).toHaveLength(3);
    expect(new Set(invocations).size).toBe(3);
  });
});
