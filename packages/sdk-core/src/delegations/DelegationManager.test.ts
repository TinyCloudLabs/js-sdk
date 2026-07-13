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
    const fetch = mock(async () => new Response(null, { status: 200 }));
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
