import { describe, expect, test } from "bun:test";
import { PartialNodeWriteError, routeResourceRequest, type ResourceTransport, type ServiceSession } from "@tinycloud/sdk-services";
import { DelegationManager } from "./DelegationManager";
import { importPortableDelegation } from "./portable";
import { SpaceService } from "../spaces/SpaceService";

const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const AUTHORIZATION = "synthetic-test-authorization";
const session = { spaceId: SPACE } as ServiceSession;

function manager(host: string, resourceTransport?: ResourceTransport) {
  return new DelegationManager({
    hosts: [host], session, accountSpaceId: SPACE,
    invoke: () => ({ Authorization: AUTHORIZATION }),
    invokeAny: () => ({ Authorization: AUTHORIZATION }),
    sessionInvocationSigner: { did: () => "did:key:zTest", sign: async () => AUTHORIZATION },
    fetch: globalThis.fetch.bind(globalThis), resourceTransport,
  });
}

const operations = {
  revoke: (m: DelegationManager) => m.revoke("bafy-test", { targetSpaceId: SPACE }),
  status: (m: DelegationManager) => m.status("bafy-test"),
  query: (m: DelegationManager) => m.query(),
  issuedQuery: (m: DelegationManager) => m.query({ direction: "issued" }),
  issuedRevoke: (m: DelegationManager) => m.revokeIssued("bafy-test"),
  chain: (m: DelegationManager) => m.getChain("bafy-test"),
  permission: (m: DelegationManager) => m.checkPermission("shared", "tinycloud.kv/get"),
};

// Real transport fanout records an earlier successful side effect before a refusal.
// Reusing its error as the adapter input also exercises node-local/read adapters,
// without changing the routing contract to make those operations fan out.
async function partialOutcome() {
  const writes: string[] = [];
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    writes.push("first");
    return Response.json({ activated: [SPACE] });
  } });
  const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    writes.push("second");
    return new Response("refused", { status: 403 });
  } });
  try {
    await routeResourceRequest([{ resource: SPACE, access: "write" }], {
      resolveResource: async () => [{ url: first.url.origin }, { url: second.url.origin }],
    }, (target) => fetch(`${target.url}/delegate`, { method: "POST", redirect: "error" }));
    throw new Error("expected partial write");
  } catch (error) {
    expect(error).toBeInstanceOf(PartialNodeWriteError);
    expect(writes).toEqual(["first", "second"]);
    return error as PartialNodeWriteError;
  } finally {
    first.stop(true);
    second.stop(true);
  }
}

describe("Core native redirect boundaries", () => {
  for (const [name, operation] of Object.entries(operations)) {
    test(`${name} refuses a native same-origin 307 before forwarding credentials or body`, async () => {
      const observed: { authorization: string | null; body: string }[] = [];
      const initial: { path: string; method: string; authorization: string | null; body: string }[] = [];
      let sends = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/info") return Response.json({ features: ["delegation-issued-query-v1"] });
        if (path === "/observer") {
          observed.push({ authorization: request.headers.get("authorization"), body: await request.text() });
          return Response.json({});
        }
        sends++;
        initial.push({ path, method: request.method, authorization: request.headers.get("authorization"), body: await request.text() });
        return new Response(null, { status: 307, headers: { location: "/observer" } });
      } });
      try {
        await operation(manager(server.url.origin));
        expect(sends).toBe(1);
        expect(observed).toEqual([]);
        if (name === "revoke") {
          expect(initial).toEqual([{ path: "/revoke", method: "POST", authorization: AUTHORIZATION, body: "" }]);
        } else if (name === "status") {
          expect(initial[0]).toMatchObject({ path: "/delegation/status", method: "POST", authorization: AUTHORIZATION });
          expect(JSON.parse(initial[0]!.body)).toEqual({ cid: "bafy-test" });
        }
      } finally { server.stop(true); }
    });
  }

  test("portable import refuses a native 307 before forwarding its bearer", async () => {
    let observed = 0;
    let sends = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/observer") { observed++; return Response.json({}); }
      sends++;
      return new Response(null, { status: 307, headers: { location: "/observer" } });
    } });
    try {
      const pending = importPortableDelegation(globalThis.fetch.bind(globalThis), server.url.origin, {
        cid: "bafy-test", delegationHeader: { Authorization: AUTHORIZATION },
        ownerAddress: "0x0000000000000000000000000000000000000001", chainId: 1,
        spaceId: SPACE, path: "shared", actions: ["tinycloud.kv/get"],
        expiry: new Date("2099-01-01"), delegateDID: "did:key:zTest",
      });
      await pending.catch(() => undefined);
      expect(sends).toBe(1);
      expect(observed).toBe(0);
    } finally { server.stop(true); }
  });

  test("space-scoped revoke refuses a native 307 before forwarding its body", async () => {
    const observed: string[] = [];
    let sends = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/observer") { observed.push(await request.text()); return new Response(null); }
      sends++;
      return new Response(null, { status: 307, headers: { location: "/observer" } });
    } });
    try {
      const spaces = new SpaceService({ hosts: [server.url.origin], session,
        invoke: () => ({ Authorization: AUTHORIZATION }), fetch: globalThis.fetch.bind(globalThis),
      });
      await spaces.get(SPACE).delegations.revoke("bafy-test");
      expect(sends).toBe(1);
      expect(observed).toEqual([]);
    } finally { server.stop(true); }
  });
});

describe("Core routing error adapters", () => {
  for (const [name, operation] of Object.entries(operations)) {
    test(`${name} preserves real partial-write receipts, public code and cause`, async () => {
      const partial = await partialOutcome();
      const transport: ResourceTransport = async () => { throw partial; };
      const m = manager("http://127.0.0.1:1", transport);
      // Chain/check use the invocation fetch adapter rather than resourceTransport.
      if (name === "chain" || name === "permission") {
        const invocationManager = new DelegationManager({ hosts: ["http://127.0.0.1:1"], session,
          invoke: () => ({ Authorization: AUTHORIZATION }), fetch: async () => { throw partial; },
        });
        const result = await operation(invocationManager);
        expect(result).toMatchObject({ ok: false, error: { code: "PARTIAL_NODE_WRITE", meta: {
          succeeded: partial.succeeded, failed: partial.failed,
        } } });
        if (result.ok) throw new Error("expected failure");
        expect(result.error.cause).toBe(partial);
        return;
      }
      const result = await operation(m);
      expect(result).toMatchObject({ ok: false, error: { code: "PARTIAL_NODE_WRITE", meta: {
        succeeded: partial.succeeded, failed: partial.failed,
      } } });
      if (result.ok) throw new Error("expected failure");
      expect(result.error.cause).toBe(partial);
    });
  }

  for (const [name, operation] of Object.entries({
    list: (spaces: SpaceService) => spaces.list(),
    create: (spaces: SpaceService) => spaces.create("redirect-test"),
    info: (spaces: SpaceService) => spaces.get(SPACE).info(),
    granted: (spaces: SpaceService) => spaces.get(SPACE).delegations.list(),
    received: (spaces: SpaceService) => spaces.get(SPACE).delegations.listReceived(),
  })) {
    test(`space ${name} refuses a native 307 before forwarding credentials or body`, async () => {
      let observed = 0;
      let sends = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/observer") { observed++; return Response.json({}); }
        sends++;
        return new Response(null, { status: 307, headers: { location: "/observer" } });
      } });
      try {
        await operation(new SpaceService({ hosts: [server.url.origin], session,
          invoke: () => ({ Authorization: AUTHORIZATION }), fetch: globalThis.fetch.bind(globalThis),
        }));
        expect(sends).toBe(1);
        expect(observed).toBe(0);
      } finally { server.stop(true); }
    });
  }
});

test("issued feature discovery refuses a native 307", async () => {
  let observed = 0;
  let discoveries = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") {
      discoveries++;
      return new Response(null, { status: 307, headers: { location: "/observer" } });
    }
    if (path === "/observer") {
      observed++;
      return Response.json({ features: ["delegation-issued-query-v1"] });
    }
    return Response.json({ schemaVersion: 2, items: [] });
  } });
  try {
    await manager(server.url.origin).query({ direction: "issued" });
    expect(discoveries).toBe(1);
    expect(observed).toBe(0);
  } finally { server.stop(true); }
});
