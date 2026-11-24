import { describe, expect, mock, test } from "bun:test";
import { rawEncryptionOwnerMatches } from "./owner-did.js";

const OWNER_DID = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const OWNER_LOWER = "did:pkh:eip155:1:0xd559ccd9eb87c530a9a349262669386de93cf412";
const OTHER_DID = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const activeProfile: Record<string, unknown> = {
  name: "agent", host: "https://node.tinycloud.test", chainId: 1, spaceName: "default",
  did: "did:key:z6MkSession", ownerDid: OWNER_DID, createdAt: "2026-06-01T00:00:00.000Z",
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: { getProfile: async () => activeProfile, getSession: async () => null },
}));

// Imported after mock.module so permissions.ts sees the mocked ProfileManager.
const { loadManifestPermissions } = await import("./permissions.js");

function manifestSource(manifest: Record<string, unknown>): string {
  return `base64:${Buffer.from(JSON.stringify(manifest)).toString("base64")}`;
}

const encryption = <T extends { service: string }>(permissions: T[]) =>
  permissions.filter((permission) => permission.service === "tinycloud.encryption");

describe("per-secret keys in CLI manifests", () => {
  test("a secrets block reads each secret with its own key, plus the network decrypt until the flip", async () => {
    const permissions = await loadManifestPermissions(
      manifestSource({ app_id: "xyz.tinycloud.agent", secrets: { OPENAI_API_KEY: true, ELEVENLABS_API_KEY: ["get"] } }),
      "agent", { allowLogicalSpaces: true },
    );
    expect(encryption(permissions).map((permission) => permission.path).sort()).toEqual([
      `urn:tinycloud:encryption:${OWNER_DID}:default`,
      `urn:tinycloud:encryption:${OWNER_DID}:default/secrets/elevenlabs_api_key`,
      `urn:tinycloud:encryption:${OWNER_DID}:default/secrets/openai_api_key`,
    ]);
    expect(encryption(permissions).every((permission) =>
      permission.space === "encryption" && permission.actions.join() === "tinycloud.encryption/decrypt")).toBe(true);
  });

  test("a secret name over 64 characters is refused by the manifest, never given the network decrypt", async () => {
    const long = `A${"B".repeat(64)}`;
    await expect(loadManifestPermissions(
      manifestSource({ app_id: "xyz.tinycloud.agent", secrets: { [long]: true } }),
      "agent", { allowLogicalSpaces: true },
    )).rejects.toThrow(/must match/);
  });

  test("an explicit exact-key entry (the tc-secrets skill's manifest) is requested with its owner in EIP-55 form", async () => {
    const permissions = await loadManifestPermissions(manifestSource({
      app_id: "xyz.tinycloud.agent",
      space: "secrets",
      permissions: [
        { service: "tinycloud.kv", path: "vault/secrets/OPENAI_API_KEY", skipPrefix: true, actions: ["get"] },
        { service: "tinycloud.encryption", path: `urn:tinycloud:encryption:${OWNER_LOWER}:default/secrets/openai_api_key`, actions: ["decrypt"] },
      ],
    }), "agent", { allowLogicalSpaces: true });
    expect(encryption(permissions)).toEqual([{
      service: "tinycloud.encryption",
      space: "encryption",
      path: `urn:tinycloud:encryption:${OWNER_DID}:default/secrets/openai_api_key`,
      actions: ["tinycloud.encryption/decrypt"],
    }]);
  });

  test.each([
    ["the secrets prefix", `urn:tinycloud:encryption:${OWNER_DID}:default/secrets/`],
    ["an app key", `urn:tinycloud:encryption:${OWNER_DID}:default/apps/xyz.tinycloud.agent/k`],
    ["another network's secret key", `urn:tinycloud:encryption:${OWNER_DID}:work/secrets/openai_api_key`],
  ])("%s is refused before sign-in", async (_label, path) => {
    await expect(loadManifestPermissions(manifestSource({
      app_id: "xyz.tinycloud.agent",
      permissions: [{ service: "tinycloud.encryption", path, actions: ["decrypt"] }],
    }), "agent", { allowLogicalSpaces: true })).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });
});

describe("signed per-secret key grants", () => {
  const key = (owner: string, rest: string) => `urn:tinycloud:encryption:${owner}:${rest}`;

  test("one secret's key on the signer's default network is the signer's", () => {
    expect(rawEncryptionOwnerMatches(key(OWNER_LOWER, "default/secrets/openai_api_key"), OWNER_DID)).toBe(true);
    expect(rawEncryptionOwnerMatches(key(OWNER_DID, "default/secrets/scoped/google-meet/refresh_token"), OWNER_DID)).toBe(true);
    expect(rawEncryptionOwnerMatches(key(OTHER_DID, "default/secrets/openai_api_key"), OWNER_DID)).toBe(false);
    expect(rawEncryptionOwnerMatches(key(OWNER_DID, "work/secrets/openai_api_key"), OWNER_DID)).toBe(false);
    expect(rawEncryptionOwnerMatches(key(OWNER_DID, "default/apps/x/k"), OWNER_DID)).toBe(false);
  });

  test("a signed secrets/ prefix is never the signer's: no CLI flow asks for one", () => {
    expect(rawEncryptionOwnerMatches(key(OWNER_DID, "default/secrets/"), OWNER_DID)).toBe(false);
    expect(rawEncryptionOwnerMatches(key(OWNER_DID, "default/secrets/scoped/feed/"), OWNER_DID)).toBe(false);
  });
});
