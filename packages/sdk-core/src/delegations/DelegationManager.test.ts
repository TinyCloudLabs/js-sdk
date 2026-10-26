import { describe, expect, mock, test } from "bun:test";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { DelegationManager } from "./DelegationManager";

describe("DelegationManager.revoke", () => {
  test("cryptographically binds the target CID and uses the node revocation endpoint", async () => {
    const session = {
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:feed",
    } as ServiceSession;
    const invoke = mock(() => ({ Authorization: "TinyCloudInvocation fixture" }));
    const invokeAny = mock(() => ({ Authorization: "TinyCloudRevocation fixture" }));
    const fetch = mock(async () => new Response(JSON.stringify({
      revoked: true,
      cid: "bafy-child",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session,
      invoke,
      invokeAny,
      fetch,
    });

    const result = await manager.revoke("bafy-child");

    expect(result.ok).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(invokeAny).toHaveBeenCalledWith(session, [{
      resource: "urn:cid:bafy-child",
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/revoke",
    }]);
    expect(fetch).toHaveBeenCalledWith("https://node.tinycloud.xyz/revoke", {
      method: "POST",
      headers: { Authorization: "TinyCloudRevocation fixture" },
    });
    expect(result).toEqual({ ok: true, data: { revoked: true, cid: "bafy-child" } });
  });

  test("includes target space and command-scoped authority when signing a CID revocation", async () => {
    const session = { spaceId: "tinycloud:pkh:eip155:1:owner:source" } as ServiceSession;
    const targetSpaceId = "tinycloud:pkh:eip155:1:owner:target";
    const authorityCid = "bafy-command-authority";
    let signedEntry: any;
    const invokeAny = mock((...args: any[]) => {
      signedEntry = args[1][0];
      return { Authorization: "revocation" };
    });
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny,
      fetch: mock(async () => new Response(JSON.stringify({
        revoked: true,
        cid: "bafy-child",
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });

    const result = await manager.revoke("bafy-child", { targetSpaceId, authorityCid });

    expect(result.ok).toBe(true);
    expect(invokeAny).toHaveBeenCalledWith(session, [{
      resource: "urn:cid:bafy-child",
      spaceId: targetSpaceId,
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/revoke",
    }]);
    expect(signedEntry.revokeAuthorityCid).toBe(authorityCid);
    expect(Object.keys(signedEntry)).not.toContain("revokeAuthorityCid");
  });


  test("fails closed when raw-resource signing is unavailable", async () => {
    const fetch = mock(async () => new Response(null, { status: 200 }));
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      fetch,
    });

    const result = await manager.revoke("bafy-child");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "NOT_INITIALIZED",
        message: expect.stringContaining("invokeAny"),
      }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects a malformed or mismatched node receipt", async () => {
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny: mock(() => ({ Authorization: "fixture" })),
      fetch: mock(async () => new Response(JSON.stringify({
        revoked: true,
        cid: "bafy-other",
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });

    expect((await manager.revoke("bafy-child")).ok).toBe(false);
  });


  test("preserves an HTTP authorization rejection instead of reporting revocation success", async () => {
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny: mock(() => ({ Authorization: "fixture" })),
      fetch: mock(async () => new Response("Unauthorized Revoker", { status: 403 })),
    });

    const result = await manager.revoke("bafy-child");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("A rejected revocation cannot succeed");
    expect(result.error.code).toBe("REVOCATION_FAILED");
    expect(result.error.message).toContain("403 - Unauthorized Revoker");
    expect(result.error.meta).toEqual({ status: 403, cid: "bafy-child" });
  });

  test("reports an unknown target as not found", async () => {
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny: mock(() => ({ Authorization: "fixture" })),
      fetch: mock(async () => new Response("MissingParents", { status: 404 })),
    });

    expect(await manager.revoke("bafy-unknown")).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "NOT_FOUND",
        message: "Delegation not found: bafy-unknown",
      }),
    });
  });
});

describe("DelegationManager.query", () => {
  test("rejects invalid filters before signing or sending a request", async () => {
    const invokeAny = mock(() => ({ Authorization: "unused" }));
    const fetch = mock(async () => new Response(null, { status: 200 }));
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny,
      fetch,
    });

    const result = await manager.query({ limit: 101 } as never);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "INVALID_INPUT" }),
    });
    expect(invokeAny).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("makes one signed account request and preserves resources, caveats, and dates", async () => {
    const session = { spaceId: "tinycloud:pkh:eip155:1:owner:applications" } as ServiceSession;
    const accountSpaceId = "tinycloud:pkh:eip155:1:owner:account";
    const invokeAny = mock(() => ({ Authorization: "query" }));
    const fetch = mock(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      items: [{
        cid: "bafy-child",
        direction: "granted",
        delegatorDid: "did:pkh:eip155:1:owner",
        delegateDid: "did:pkh:eip155:1:bob",
        resources: [{
          resource: "tinycloud:pkh:eip155:1:owner:files/kv/docs",
          actions: ["tinycloud.kv/get"],
          caveats: [{ prefix: "reports/" }],
        }],
        parents: [],
        issuedAt: "2026-07-15T12:00:00Z",
        notBefore: null,
        expiresAt: "2026-07-16T12:00:00Z",
        status: "active",
      }],
      nextCursor: "bafy-child",
    }), { headers: { "content-type": "application/json" } }));
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      accountSpaceId,
      session,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny,
      fetch,
    });

    const result = await manager.query({ direction: "granted", limit: 25 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items[0]?.issuedAt).toBeInstanceOf(Date);
      expect(result.data.items[0]?.resources[0]?.caveats).toEqual([{ prefix: "reports/" }]);
    }
    expect(invokeAny).toHaveBeenCalledTimes(1);
    expect(invokeAny).toHaveBeenCalledWith(session, [{
      spaceId: accountSpaceId,
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/list",
    }]);
    expect(fetch).toHaveBeenCalledWith("https://node.tinycloud.xyz/delegation/query", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ direction: "granted", limit: 25 }),
    }));
    const request = fetch.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("Authorization")).toBe("query");
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
  });

  test("rejects non-RFC3339 delegation timestamps", async () => {
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      accountSpaceId: "tinycloud:pkh:eip155:1:owner:account",
      session: { spaceId: "tinycloud:pkh:eip155:1:owner:account" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny: mock(() => ({ Authorization: "query" })),
      fetch: mock(async () => new Response(JSON.stringify({
        schemaVersion: 2,
        items: [{
          cid: "bafy-child",
          direction: "granted",
          delegatorDid: "did:pkh:eip155:1:owner",
          delegateDid: "did:pkh:eip155:1:bob",
          resources: [],
          parents: [],
          issuedAt: 0,
          notBefore: null,
          expiresAt: "July 16, 2026",
          status: "active",
        }],
      }), { headers: { "content-type": "application/json" } })),
    });

    expect((await manager.query()).ok).toBe(false);
  });
});

describe("DelegationManager.status", () => {
  test("binds the same target CID in the signed resource and request body", async () => {
    const session = { spaceId: "space" } as ServiceSession;
    const invokeAny = mock(() => ({ Authorization: "TinyCloudStatus fixture" }));
    const fetch = mock(async () => new Response(JSON.stringify({
      cid: "bafy-child",
      status: "revoked",
      exists: true,
      active: false,
      revoked: true,
      expired: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny,
      fetch,
    });

    const result = await manager.status("bafy-child");

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ status: "revoked" }) });
    expect(invokeAny).toHaveBeenCalledWith(session, [{
      resource: "urn:cid:bafy-child",
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/status",
    }]);
    expect(fetch).toHaveBeenCalledWith("https://node.tinycloud.xyz/delegation/status", {
      method: "POST",
      headers: {
        Authorization: "TinyCloudStatus fixture",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cid: "bafy-child" }),
    });
  });

  test("returns an indistinguishable not-found status and rejects CID mismatch", async () => {
    const responses = [
      new Response(JSON.stringify({
        cid: "bafy-child",
        status: "not_found",
        exists: false,
        active: false,
        revoked: false,
        expired: false,
      }), { status: 404, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({
        cid: "bafy-other",
        status: "active",
        exists: true,
        active: true,
        revoked: false,
        expired: false,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny: mock(() => ({ Authorization: "fixture" })),
      fetch: mock(async () => responses.shift()!),
    });

    expect(await manager.status("bafy-child")).toEqual({
      ok: true,
      data: expect.objectContaining({ status: "not_found", exists: false }),
    });
    expect((await manager.status("bafy-child")).ok).toBe(false);
  });

  test("rejects HTTP/body status mismatches and contradictory revoked flags", async () => {
    const bodies = [
      { cid: "bafy-child", status: "active", exists: true, active: true, revoked: false, expired: false },
      { cid: "bafy-child", status: "not_found", exists: false, active: false, revoked: false, expired: false },
      { cid: "bafy-child", status: "revoked", exists: true, active: false, revoked: true, expired: true },
    ];
    const statuses = [404, 200, 200];
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny: mock(() => ({ Authorization: "fixture" })),
      fetch: mock(async () => new Response(JSON.stringify(bodies.shift()), {
        status: statuses.shift(),
        headers: { "content-type": "application/json" },
      })),
    });

    expect((await manager.status("bafy-child")).ok).toBe(false);
    expect((await manager.status("bafy-child")).ok).toBe(false);
    expect((await manager.status("bafy-child")).ok).toBe(false);
  });
});

describe("DelegationManager invoke paths", () => {
  const emptyOk = () => new Response("", { status: 200 });
  const make = (fetch: () => Promise<Response>) =>
    new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      session: { spaceId: "space" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "TinyCloudInvocation fixture" })),
      fetch,
    });

  test("an empty 200 from getChain is an unsupported operation, not a parse failure", async () => {
    const result = await make(async () => emptyOk()).getChain("bafy-child");
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "UNSUPPORTED_OPERATION", meta: expect.objectContaining({ status: 200 }) }),
    });
  });

  test("an empty 200 from checkPermission is an unsupported operation, not a parse failure", async () => {
    const result = await make(async () => emptyOk()).checkPermission("a/", "tinycloud.kv/get");
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }),
    });
  });

  test("a populated checkPermission body is still read", async () => {
    const result = await make(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }))
      .checkPermission("a/", "tinycloud.kv/get");
    expect(result).toEqual({ ok: true, data: true });
  });
});

describe("DelegationManager.query space choice", () => {
  const accountSpaceId = "tinycloud:pkh:eip155:1:owner:account";
  const defaultSpaceId = "tinycloud:pkh:eip155:1:owner:default";
  const page = () => new Response(JSON.stringify({ schemaVersion: 2, items: [] }), { status: 200 });
  const forbidden = () => new Response("Delegation query proof is not authorized", { status: 403 });
  const make = (responses: Array<() => Response>) => {
    const invokeAny = mock((_session: ServiceSession, _requests: Array<{ spaceId?: string }>) => ({ Authorization: "query" }));
    const queue = [...responses];
    const fetch = mock(async () => queue.shift()!());
    const manager = new DelegationManager({
      hosts: ["https://node.tinycloud.xyz"],
      accountSpaceId,
      session: { spaceId: defaultSpaceId } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny,
      fetch,
    });
    return { manager, invokeAny, fetch };
  };

  test("signs for the account space when the session holds delegation/list there", async () => {
    const { manager, invokeAny, fetch } = make([page]);
    expect((await manager.query()).ok).toBe(true);
    expect(invokeAny.mock.calls.map(([, requests]) => requests[0]?.spaceId)).toEqual([accountSpaceId]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("falls back to the session's own space when the account space is refused", async () => {
    const { manager, invokeAny, fetch } = make([forbidden, page]);
    expect((await manager.query()).ok).toBe(true);
    expect(invokeAny.mock.calls.map(([, requests]) => requests[0]?.spaceId)).toEqual([accountSpaceId, defaultSpaceId]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("a session that holds delegation/list nowhere gets a typed permission error", async () => {
    const { manager, fetch } = make([forbidden, forbidden]);
    expect(await manager.query()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "PERMISSION_DENIED", meta: { status: 403 } }),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("scope.spaces signs only for the listed spaces", async () => {
    const { manager, invokeAny, fetch } = make([page]);
    expect((await manager.query({}, { spaces: [defaultSpaceId] })).ok).toBe(true);
    expect(invokeAny.mock.calls.map(([, requests]) => requests[0]?.spaceId)).toEqual([defaultSpaceId]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("an empty scope.spaces sends nothing and answers a typed permission error", async () => {
    const { manager, invokeAny, fetch } = make([page]);
    expect(await manager.query({}, { spaces: [] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "PERMISSION_DENIED" }),
    });
    expect(invokeAny).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
