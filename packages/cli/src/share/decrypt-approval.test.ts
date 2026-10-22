import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ProfileConfig } from "../config/types.js";
import { ProfileManager } from "../config/profiles.js";

const deviceRequests: unknown[] = [];
const activations: unknown[][] = [];

mock.module("../auth/device-auth.js", () => ({
  resolveDeviceApiHost: () => "https://openkey.example",
  runDeviceAuthorization: async (input: unknown) => {
    deviceRequests.push(input);
    return { session: { delegation: "approved" } };
  },
}));

mock.module("../auth/local-key.js", () => ({
  keyToDID: () => "did:key:z6MkTest",
}));

mock.module("../commands/auth.js", () => ({
  portableFromOpenKeyDelegation: () => ({ approved: true }),
  activateAndStoreOpenKeyGrants: async (...args: unknown[]) => {
    activations.push(args);
  },
}));

mock.module("../lib/permissions.js", () => ({
  permissionsFromDelegation: () => [],
}));

const { approveShareDecrypt, DECRYPT_APPROVAL_TTL_SECONDS } = await import("./decrypt-approval.js");

const profile = {
  name: "test",
  host: "https://node.example",
  did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
  sessionDid: "did:key:z6MkSession",
} as unknown as ProfileConfig;

describe("share decrypt approval", () => {
  beforeEach(() => {
    deviceRequests.length = 0;
    activations.length = 0;
    spyOn(ProfileManager, "getProfile").mockResolvedValue(profile);
    spyOn(ProfileManager, "getKey").mockResolvedValue({ kty: "OKP" });
  });

  it("requests exactly the decrypt entry for about one hour", async () => {
    await approveShareDecrypt({ profileName: "test", node: {} as never });
    expect(deviceRequests).toHaveLength(1);
    const request = deviceRequests[0] as { permissions: unknown; expiry: { durationMs: number } };
    expect(request.permissions).toEqual([{
      service: "tinycloud.encryption",
      space: "default",
      path: "",
      actions: ["tinycloud.encryption/decrypt"],
    }]);
    expect(request.expiry.durationMs).toBe(DECRYPT_APPROVAL_TTL_SECONDS * 1000);
    expect(DECRYPT_APPROVAL_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });

  it("stores the approved grant under the profile without a new sign-in", async () => {
    await approveShareDecrypt({ profileName: "test", node: {} as never });
    expect(activations).toHaveLength(1);
    expect(activations[0]?.[0]).toBe("test");
    expect(activations[0]?.[1]).toBe("https://node.example");
    expect(activations[0]?.[4]).toBe("cli");
  });
});
