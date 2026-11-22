import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSecretKeyPath } from "../../../sdk-core/src/manifest.js";

// TC-3284 (Naomi 13:05Z, Bobbie 13:07Z): no client builds a decrypt request on a `secrets/` key PREFIX. The only
// allowed prefix builders are the SM /app owner sign-in and the owner-only CLI `auth login --paste --all-secrets`;
// neither is in cli/operations/mcp on this branch. Every decrypt builder here yields one secret's exact key or a
// whole network, and no agent-facing text names `--all-secrets`.

const OWNER_DID = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const NETWORK = `urn:tinycloud:encryption:${OWNER_DID}:default`;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    getProfile: async () => ({
      name: "agent", host: "https://node.tinycloud.test", chainId: 1, spaceName: "default",
      did: "did:key:z6MkSession", ownerDid: OWNER_DID, createdAt: "2026-06-01T00:00:00.000Z",
    }),
    getSession: async () => null,
  },
}));

// Imported after mock.module so the builders see the mocked ProfileManager.
const { loadManifestPermissions, resolvePermissionSpaces } = await import("./permissions.js");
const { parseKeysPrefix } = await import("./named-keys.js");
const { secretMigrateKeyPermissions, secretMigratePermissions } = await import("../commands/secrets.js");

/** A resource under a network's `secrets/` keys that is not exactly one secret's key. */
function isSecretsPrefix(path: string): boolean {
  const match = /^urn:tinycloud:encryption:did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:[a-z0-9][a-z0-9-]*\/(secrets(?:\/.*)?)$/.exec(path);
  return match !== null && (match[1]!.endsWith("/") || !isSecretKeyPath(match[1]!));
}

function expectNoSecretsPrefix(entries: readonly { service: string; path: string }[]): void {
  const encryption = entries.filter((entry) => entry.service === "tinycloud.encryption" || entry.service === "encryption");
  expect(encryption.length).toBeGreaterThan(0);
  expect(encryption.filter((entry) => isSecretsPrefix(entry.path))).toEqual([]);
}

const base64 = (manifest: Record<string, unknown>) => `base64:${Buffer.from(JSON.stringify(manifest)).toString("base64")}`;

describe("decrypt builders never yield a secrets/ prefix", () => {
  test("the predicate tells an exact key from a prefix", () => {
    expect(isSecretsPrefix(`${NETWORK}/secrets/openai_api_key`)).toBe(false);
    expect(isSecretsPrefix(`${NETWORK}/secrets/scoped/my-app/openai_api_key`)).toBe(false);
    expect(isSecretsPrefix(NETWORK)).toBe(false);
    for (const prefix of ["secrets", "secrets/", "secrets/scoped/", "secrets/scoped/my-app/"]) {
      expect(isSecretsPrefix(`${NETWORK}/${prefix}`)).toBe(true);
    }
  });

  test("secrets migrate (cli/src/commands/secrets.ts secretMigratePermissions, secretMigrateKeyPermissions): the network root, then exact keys", () => {
    expectNoSecretsPrefix(secretMigratePermissions(undefined, NETWORK, false));
    expect(secretMigratePermissions(undefined, NETWORK, true).some((entry) => entry.service === "tinycloud.encryption")).toBe(false);
    const keys = secretMigrateKeyPermissions(NETWORK, ["secrets/openai_api_key", "secrets/scoped/my-app/other_key"]);
    expectNoSecretsPrefix(keys);
    expect(keys.map((entry) => entry.path)).toEqual([
      `${NETWORK}/secrets/openai_api_key`,
      `${NETWORK}/secrets/scoped/my-app/other_key`,
    ]);
  });

  test("a manifest secrets block (cli/src/lib/permissions.ts secretPermissionsFromAppManifest): exact keys plus the network root", async () => {
    expectNoSecretsPrefix(await loadManifestPermissions(
      base64({ app_id: "xyz.tinycloud.agent", secrets: { OPENAI_API_KEY: true, ELEVENLABS_API_KEY: ["get"] } }),
      "agent", { allowLogicalSpaces: true },
    ));
  });

  for (const prefix of ["secrets", "secrets/", "secrets/scoped/my-app/"]) {
    test(`a manifest raw entry (permissions.ts appManifestEntry) on ${prefix} is refused`, async () => {
      await expect(loadManifestPermissions(base64({
        app_id: "xyz.tinycloud.agent",
        permissions: [{ service: "tinycloud.encryption", path: `${NETWORK}/${prefix}`, actions: ["decrypt"] }],
      }), "agent", { allowLogicalSpaces: true })).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    });

    test(`a requested raw entry (permissions.ts resolvePermissionSpaces) on ${prefix} is refused`, async () => {
      await expect(resolvePermissionSpaces(
        [{ service: "tinycloud.encryption", space: "encryption", path: `${NETWORK}/${prefix}`, actions: ["decrypt"] }],
        "agent",
      )).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    });
  }

  test("a requested exact key and the network root pass resolvePermissionSpaces unchanged", async () => {
    const entries = [NETWORK, `${NETWORK}/secrets/openai_api_key`].map((path) =>
      ({ service: "tinycloud.encryption", space: "encryption", path, actions: ["tinycloud.encryption/decrypt"] }));
    expect((await resolvePermissionSpaces(entries, "agent")).map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
  });

  test("--keys (cli/src/lib/named-keys.ts parseKeysPrefix) refuses every folder under secrets/", () => {
    for (const folder of ["secrets", "secrets/", "secrets/scoped"]) {
      expect(() => parseKeysPrefix(folder, OWNER_DID)).toThrow();
    }
  });
});

// Every non-test source file in cli/operations/mcp that names the decrypt capability, with what it builds. A new
// file fails here until its builder is reviewed against the rule and listed.
const DECRYPT_BUILDERS: Record<string, string> = {
  "cli/src/auth/invitation-key-grant.ts": "checks a signed invitation grant: one exact share/<hex> key",
  "cli/src/auth/scoped-login.ts": "checks signed grants: network, share/, one share key or one exact secret key (rawEncryptionOwnerMatches)",
  "cli/src/commands/replica.ts": "warning text only",
  "cli/src/commands/secrets.ts": "secretPermissionEntries (exact key, network root for an older-format secret or a non-default network), ownerSecretApproval (details.decrypt: exact key or network root), secretMigratePermissions (network root), secretMigrateKeyPermissions (exact keys), `secrets network grant` (network root)",
  "cli/src/lib/permissions.ts": "secretPermissionsFromAppManifest (exact keys + network root), appManifestEntry and resolvePermissionSpaces (refuse secrets/ prefixes), share/ prefix (Share, not secrets), device default network root",
  "cli/src/lib/raw-encryption.ts": "matchers for the share/ prefix and device default network root",
  "cli/src/share/adapters.ts": "runtime check on the network root",
  "cli/src/share/publishing-manifest.ts": "default/share/ prefix (Share publishing, not secrets)",
  "operations/src/invoke.ts": "checks a planned decrypt is one raw encryption resource",
  "operations/src/operations/secrets-get.ts": "planSecretDecrypt: exact key, or network root when the session already holds it and not the key, or on a non-default network",
  "operations/src/secret-capabilities.ts": "the capability constant",
};

const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));

function sources(globs: readonly string[]): string[] {
  return globs.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: PACKAGES })])
    .filter((file) => !/\.test\.ts$|\/test-support\//.test(file))
    .sort();
}

describe("decrypt builders in cli/operations/mcp are all reviewed", () => {
  const code = sources(["cli/src/**/*.ts", "operations/src/**/*.ts", "mcp/src/**/*.ts"]);

  test("every file naming the decrypt capability is a listed builder", () => {
    const found = code.filter((file) =>
      /tinycloud\.encryption\/decrypt|SECRET_DECRYPT_CAPABILITY|actions:\s*\[\s*["']decrypt["']/.test(readFileSync(PACKAGES + file, "utf8")));
    expect(found).toEqual(Object.keys(DECRYPT_BUILDERS).sort());
  });

  test("no source formats a key prefix or resource ending in secrets/", () => {
    const offenders = code.filter((file) =>
      /formatPrefixResource\([^)]*["'`]secrets|\/secrets\/`/.test(readFileSync(PACKAGES + file, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("no helper, MCP tool, generated operation or hint text names --all-secrets", () => {
    const files = [...code, ...sources(["operations/generated/**/*", "mcp/README.md", "cli/README.md", "operations/README.md"])];
    const offenders = files.filter((file) => readFileSync(PACKAGES + file, "utf8").includes("all-secrets"));
    expect(offenders).toEqual([]);
  });
});
