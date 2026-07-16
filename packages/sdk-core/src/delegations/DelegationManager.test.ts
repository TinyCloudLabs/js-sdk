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
