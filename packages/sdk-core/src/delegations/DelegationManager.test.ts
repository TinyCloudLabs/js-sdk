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
