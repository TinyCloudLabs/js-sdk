import { describe, expect, mock, test } from "bun:test";
import {
  composeManifestRequest,
  expandDelegationPermissionEntries,
  expandPermissionEntries,
  normalizeUnifiedPolicyCapability,
  validateManifest,
  ManifestValidationError,
  type ISecretsService,
  type PermissionEntry,
} from "@tinycloud/sdk-core";
import { resolveSecretPath, secretReadPermissions } from "@tinycloud/sdk-services";
import { formatKeyResource } from "@tinycloud/sdk-services/encryption/resource";

import { NodeSecretsService } from "./NodeSecretsService";

// TC-3801 (Naomi 13:05Z): the node honours an owner-issued `secrets/` PREFIX
// decrypt, which opens every secret's key. No SDK builder of a decrypt
// request, hint, recap entry or key invocation may produce one: each yields
// one secret's exact key, or the whole-network root on a named owner/legacy
// path. The only `secrets/` prefix the SDK passes on is one an owner tool put
// in an explicit capabilityRequest itself (NodeUserAuthorization); a request
// composed from a manifest can never carry it. web-sdk's WebSecretsService
// builder is covered in tests/WebSecretsService.requestPermission.test.ts.

const NETWORK = "urn:tinycloud:encryption:did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed:default";
const EXACT_SECRET_KEY = /^urn:tinycloud:encryption:[^/]+:default\/secrets\/(?:scoped\/[a-z0-9-]+\/)?[a-z][a-z0-9_]*$/;
const PREFIXES = [
  `${NETWORK}/secrets/`,
  `${NETWORK}/secrets/scoped/`,
  `${NETWORK}/secrets/scoped/food/`,
];
// Forms a review screen reads as every secret (the bare key, odd case,
// percent-encoding): a manifest or a delegation refuses them as well.
const ALL_SECRETS_FORMS = [
  ...PREFIXES,
  `${NETWORK}/secrets`,
  `${NETWORK}/Secrets/`,
  `${NETWORK}/SECRETS/x`,
  `${NETWORK}/secrets%2Fapi_key`,
];
const SECRETS: Array<[string, string?]> = [
  ["API_KEY"],
  ["A"],
  ["SECRETS"],
  ["SCOPED"],
  ["API_KEY", "food"],
  ["X_1", "a-b"],
];

/** One secret's exact key, never a prefix; the network root only where `root` names that path. */
function expectExactKey(path: string, root?: "root") {
  if (root === "root" && path === NETWORK) return;
  expect(path).toMatch(EXACT_SECRET_KEY);
  expect(path.endsWith("/")).toBe(false);
}

const decryptEntries = (entries: readonly PermissionEntry[]) =>
  entries.filter((entry) => entry.service === "tinycloud.encryption");

describe("every SDK decrypt builder yields an exact secret key, never a secrets/ prefix", () => {
  test("sdk-services secretReadPermissions and the key path resolveSecretPath gives the vault (seal, read, DECRYPT_DENIED hint)", () => {
    for (const [name, scope] of SECRETS) {
      const options = scope === undefined ? {} : { scope };
      const [, decrypt] = secretReadPermissions(NETWORK, name, options);
      expectExactKey(decrypt.path);
      // DataVaultService seals to, opens and hints on `${network}/${keyPath}`.
      expect(`${NETWORK}/${resolveSecretPath(name, options).keyPath}`).toBe(decrypt.path);
    }
  });

  test("node-sdk NodeSecretsService: an opted-in get and a put ask for exactly the secret's key; a background get hints it", async () => {
    for (const [name, scope] of SECRETS) {
      const asked: PermissionEntry[][] = [];
      const secrets = new NodeSecretsService({
        getService: () => ({
          get: mock(async () => ({ ok: true, data: "v" })),
          put: mock(async () => ({ ok: true, data: undefined })),
        }) as unknown as ISecretsService,
        getManifest: () => undefined,
        hasPermissions: () => false,
        uncoveredEntries: (entries) => entries,
        grantPermissions: async (entries) => {
          asked.push(entries);
        },
        canEscalate: () => true,
        getEncryptionNetworkId: () => NETWORK,
      });
      const options = scope === undefined ? {} : { scope };

      const background = await secrets.get(name, options);
      const hint = background.ok ? undefined : (background.error as { permissionHint?: { path: string } }).permissionHint;
      expect(hint).toBeDefined();
      expectExactKey(hint!.path);

      await secrets.get(name, { ...options, requestPermission: true });
      await secrets.put(name, "v", options);
      expect(asked).toHaveLength(2);
      for (const entry of asked.flatMap(decryptEntries)) expectExactKey(entry.path);
    }
  });

  test("node-sdk NodeSecretsService: a name or scope over 64 characters is refused with nothing asked, never the network root; 64 asks for its own key", async () => {
    const asked: PermissionEntry[][] = [];
    const base = { get: mock(async () => ({ ok: true, data: "v" })), put: mock(async () => ({ ok: true, data: undefined })) };
    const secrets = new NodeSecretsService({
      getService: () => base as unknown as ISecretsService,
      getManifest: () => undefined,
      hasPermissions: () => false,
      uncoveredEntries: (entries) => entries,
      grantPermissions: async (entries) => {
        asked.push(entries);
      },
      canEscalate: () => true,
      getEncryptionNetworkId: () => NETWORK,
    });
    for (const [name, options] of [
      [`A${"B".repeat(64)}`, {}],
      ["API_KEY", { scope: "a".repeat(65) }],
    ] as const) {
      for (const result of [
        await secrets.get(name, { ...options, requestPermission: true }),
        await secrets.get(name, options),
        await secrets.put(name, "v", options),
      ]) {
        expect(result.ok ? undefined : result.error.code).toBe("INVALID_INPUT");
      }
    }
    expect(asked).toEqual([]);
    expect(base.get).not.toHaveBeenCalled();
    expect(base.put).not.toHaveBeenCalled();

    const longest = `A${"B".repeat(63)}`;
    expect(await secrets.get(longest, { scope: "a".repeat(64), requestPermission: true })).toEqual({ ok: true, data: "v" });
    expect(decryptEntries(asked.flat()).map((entry) => entry.path)).toEqual([
      `${NETWORK}/secrets/scoped/${"a".repeat(64)}/${longest.toLowerCase()}`,
    ]);
  });

  test("sdk-core expandPermissionEntries (manifests, grantRuntimePermissions) keeps an exact key and refuses every prefix", () => {
    for (const [name, scope] of SECRETS) {
      const [, decrypt] = secretReadPermissions(NETWORK, name, scope === undefined ? {} : { scope });
      const expanded = expandPermissionEntries([{ service: "tinycloud.encryption", path: decrypt.path, actions: ["decrypt"] }]);
      for (const entry of decryptEntries(expanded)) expectExactKey(entry.path);
    }
    for (const path of ALL_SECRETS_FORMS) {
      expect(() => expandPermissionEntries([{ service: "tinycloud.encryption", path, actions: ["decrypt"] }])).toThrow(ManifestValidationError);
    }
  });

  test("sdk-core expandDelegationPermissionEntries (delegateTo) keeps an exact key and refuses every prefix and the bare secrets key", () => {
    const exact = expandDelegationPermissionEntries([{ service: "tinycloud.encryption", path: `${NETWORK}/secrets/api_key`, actions: ["decrypt"] }]);
    expect(exact.map((entry) => entry.path)).toEqual([`${NETWORK}/secrets/api_key`]);
    for (const path of ALL_SECRETS_FORMS) {
      expect(() => expandDelegationPermissionEntries([{ service: "tinycloud.encryption", path, actions: ["decrypt"] }])).toThrow(ManifestValidationError);
    }
  });

  test("sdk-core manifests: neither a permission nor a manifest key can name a secrets/ prefix", () => {
    const manifest = (path: string) => [{
      app_id: "com.example.app",
      name: "Example",
      permissions: [{ service: "tinycloud.encryption", path, actions: ["decrypt"] }],
    }];
    const composed = composeManifestRequest(manifest(`${NETWORK}/secrets/api_key`));
    expect(decryptEntries(composed.resources).map((entry) => entry.path)).toEqual([`${NETWORK}/secrets/api_key`]);
    for (const path of ALL_SECRETS_FORMS) {
      expect(() => composeManifestRequest(manifest(path))).toThrow(ManifestValidationError);
    }
    const keys = (prefix: string) => ({ app_id: "com.example.app", name: "Example", keys: [{ prefix, abilities: ["decrypt"] }] });
    expect(() => validateManifest(keys("apps/com.example.app/"))).not.toThrow();
    for (const prefix of ["secrets/", "secrets/scoped/"]) {
      expect(() => validateManifest(keys(prefix))).toThrow(ManifestValidationError);
    }
  });

  test("sdk-core unified policy capabilities refuse a prefix; the network root stays an owner capability", () => {
    for (const resource of PREFIXES) {
      expect(() => normalizeUnifiedPolicyCapability({ kind: "encryption", resource, action: "tinycloud.encryption/decrypt" })).toThrow();
    }
    for (const resource of [`${NETWORK}/secrets/api_key`, NETWORK]) {
      const capability = normalizeUnifiedPolicyCapability({ kind: "encryption", resource, action: "tinycloud.encryption/decrypt" });
      expectExactKey((capability as { resource: string }).resource, "root");
    }
  });

  test("sdk-services formatKeyResource (every named-key invocation, exactSession included) refuses a prefix", () => {
    expectExactKey(formatKeyResource(NETWORK, "secrets/api_key"));
    for (const path of ["secrets/", "secrets/scoped/", "secrets/scoped/food/"]) {
      expect(() => formatKeyResource(NETWORK, path)).toThrow();
    }
  });
});
