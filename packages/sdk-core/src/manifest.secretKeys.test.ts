import { describe, expect, test } from "bun:test";
import { composeManifestRequest, type Manifest } from "./manifest";

const LOWER = "did:pkh:eip155:1:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CANONICAL = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

function manifestWith(path: string, actions: string[]): Manifest {
  return {
    manifest_version: 1,
    app_id: "xyz.tinycloud.example",
    name: "Example",
    space: "secrets",
    defaults: false,
    permissions: [{ service: "tinycloud.encryption", path, actions }],
  } as Manifest;
}

function encryptionResources(path: string, actions: string[]) {
  return composeManifestRequest([manifestWith(path, actions)], { includeAccountRegistryPermissions: false })
    .resources.filter((resource) => resource.service === "tinycloud.encryption");
}

describe("exact per-secret keys in manifest permissions", () => {
  test("decrypt and key.create on one secret's key are emitted for the EIP-55 owner", () => {
    expect(encryptionResources(`urn:tinycloud:encryption:${LOWER}:default/secrets/openai_api_key`, ["decrypt", "key.create"])).toEqual([{
      service: "tinycloud.encryption",
      space: "encryption",
      path: `urn:tinycloud:encryption:${CANONICAL}:default/secrets/openai_api_key`,
      actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
    }]);
  });

  test("a scoped secret's key is accepted", () => {
    expect(encryptionResources(`urn:tinycloud:encryption:${CANONICAL}:default/secrets/scoped/xyz-tinycloud-feed/slack_token`, ["tinycloud.encryption/decrypt"]))
      .toEqual([expect.objectContaining({
        path: `urn:tinycloud:encryption:${CANONICAL}:default/secrets/scoped/xyz-tinycloud-feed/slack_token`,
        actions: ["tinycloud.encryption/decrypt"],
      })]);
  });

  test.each([
    ["the whole secrets prefix", "default/secrets/"],
    ["a scope prefix", "default/secrets/scoped/feed/"],
    ["the bare secrets key", "default/secrets"],
    ["an upper-case name", "default/secrets/OPENAI_API_KEY"],
    ["a reserved scope", "default/secrets/scoped/global/openai_api_key"],
    ["a name over 64 characters", `default/secrets/a${"b".repeat(64)}`],
    ["a deeper path", "default/secrets/openai_api_key/extra"],
    ["another network", "work/secrets/openai_api_key"],
    ["an app key", "default/apps/xyz.tinycloud.example/k"],
  ])("%s is refused", (_label, suffix) => {
    expect(() => encryptionResources(`urn:tinycloud:encryption:${CANONICAL}:${suffix}`, ["decrypt"])).toThrow();
  });

  test.each([["network.create"], ["key.block"], ["tinycloud.encryption/key.delete"]])("%s on a secret key is refused", (action) => {
    expect(() => encryptionResources(`urn:tinycloud:encryption:${CANONICAL}:default/secrets/openai_api_key`, [action])).toThrow();
  });
});
