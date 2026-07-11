import { beforeEach, describe, expect, mock, test } from "bun:test";

const OWNER_DID = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const OWNER_ADDRESS = "0xd559ccd9eb87c530a9a349262669386de93cf412";
let activeProfile: Record<string, unknown>;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    getProfile: async () => activeProfile,
    getSession: async () => null,
  },
}));

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
    ) {
      super(message);
      this.name = "CLIError";
    }
  },
  handleError: () => {
    throw new Error("handleError should not be called in permissions tests");
  },
  setActiveProfileName: () => {},
}));

mock.module("@tinycloud/sdk-services", () => {
  const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
  const canonicalizeSecretScope = (scope: string | undefined): string | undefined => {
    if (scope === undefined) return undefined;
    const canonical = scope
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (canonical === "default" || canonical === "global") {
      throw new Error("reserved secret scope");
    }
    return canonical;
  };
  return {
    SECRET_NAME_RE,
    resolveSecretPath: (name: string, options: { scope?: string } = {}) => {
      const scope = canonicalizeSecretScope(options.scope);
      const vaultKey = scope
        ? `secrets/scoped/${scope}/${name}`
        : `secrets/${name}`;
      return {
        name,
        ...(scope ? { scope } : {}),
        vaultKey,
        permissionPaths: {
          vault: `vault/${vaultKey}`,
        },
      };
    },
  };
});

const { loadManifestPermissions, resolvePermissionSpaces } = await import("./permissions.js");

beforeEach(() => {
  activeProfile = {
    name: "default",
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:z6MkSession",
    ownerDid: OWNER_DID,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
});

test("a fresh delegate request preserves a logical space until the owner grants it", async () => {
  activeProfile = {
    name: "delegate",
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:z6MkDelegate",
    posture: "delegate-session",
    createdAt: "2026-06-01T00:00:00.000Z",
  };

  const permissions = await resolvePermissionSpaces([{
    service: "tinycloud.kv",
    space: "applications",
    path: "xyz.tinycloud.listen/transcript/",
    actions: ["list"],
  }], "delegate");

  expect(permissions[0]).toMatchObject({
    space: "applications",
    actions: ["tinycloud.kv/list"],
  });
});

function manifestSource(manifest: Record<string, unknown>): string {
  return `base64:${Buffer.from(JSON.stringify(manifest)).toString("base64")}`;
}

describe("loadManifestPermissions", () => {
  test("adds secret read and default decrypt permissions for app manifests", async () => {
    const permissions = await loadManifestPermissions(
      manifestSource({
        app_id: "xyz.tinycloud.listen",
        name: "Listen",
        permissions: [
          {
            service: "tinycloud.sql",
            space: "listen",
            path: "transcripts.sqlite",
            actions: ["read"],
            skipPrefix: true,
          },
        ],
        secrets: {
          ASSEMBLYAI_API_KEY: {
            scope: "listen",
          },
        },
      }),
      "default",
    );

    expect(permissions).toEqual(
      expect.arrayContaining([
        {
          service: "tinycloud.kv",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:secrets`,
          path: "vault/secrets/scoped/listen/ASSEMBLYAI_API_KEY",
          actions: ["tinycloud.kv/get"],
        },
        {
          service: "tinycloud.encryption",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:encryption`,
          path: `urn:tinycloud:encryption:${OWNER_DID}:default`,
          actions: ["tinycloud.encryption/decrypt"],
          skipPrefix: true,
        },
      ]),
    );
  });

  test("does not add decrypt permission for write-only secrets", async () => {
    const permissions = await loadManifestPermissions(
      manifestSource({
        app_id: "xyz.tinycloud.listen",
        name: "Listen",
        secrets: {
          ASSEMBLYAI_API_KEY: ["write"],
        },
      }),
      "default",
    );

    expect(permissions.some((permission) => permission.service === "tinycloud.encryption")).toBe(false);
    expect(permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "tinycloud.kv",
          path: "vault/secrets/ASSEMBLYAI_API_KEY",
          actions: ["tinycloud.kv/put"],
        }),
      ]),
    );
  });
});
