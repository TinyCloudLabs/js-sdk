import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const {
  diffPermissions,
  isCompatiblePermissionRequestArtifact,
  loadManifestPermissions,
  resolvePermissionSpaces,
} = await import("./permissions.js");

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

test("uses the public SDK capability-subset semantics for exact missing permissions", () => {
  const missing = diffPermissions(
    [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] }],
    [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/", actions: ["tinycloud.kv/*"] }],
  );

  expect(missing).toEqual([]);
});

test("snapshots the shipped session, delegation, and request writer layouts", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-layout-"));
  const permissionsUrl = new URL("./permissions.ts", import.meta.url).href;
  const profilesUrl = new URL("../config/profiles.ts", import.meta.url).href;
  const script = `
    const { ProfileManager } = await import(${JSON.stringify(profilesUrl)});
    const {
      appendAdditionalDelegation,
      appendPermissionRequestArtifact,
    } = await import(${JSON.stringify(permissionsUrl)});
    await ProfileManager.setSession("snapshot", {
      authMethod: "openkey",
      address: "0xOwner",
      chainId: 1,
      spaceId: "tinycloud:pkh:eip155:1:0xOwner:secrets",
      delegationCid: "bafy-session",
      verificationMethod: "did:key:session",
    });
    await appendAdditionalDelegation("snapshot", {
      delegation: {
        cid: "bafy-additional",
        spaceId: "tinycloud:pkh:eip155:1:0xOwner:secrets",
        path: "vault/secrets/KEY",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:session",
        ownerAddress: "0xOwner",
        chainId: 1,
        expiry: new Date("2099-01-01T00:00:00.000Z"),
        delegationHeader: { Authorization: "encoded" },
      },
      permissions: [{
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/KEY",
        actions: ["tinycloud.kv/get"],
      }],
    });
    await appendPermissionRequestArtifact("snapshot", {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_snapshot",
      createdAt: "2026-07-14T12:00:00.000Z",
      profile: "snapshot",
      posture: "delegate-session",
      operatorType: "agent",
      host: "https://node.tinycloud.test",
      sessionDid: "did:key:session",
      requested: [{
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/KEY",
        actions: ["tinycloud.kv/get"],
      }],
    });
    const fs = await import("node:fs/promises");
    const result = {};
    for (const name of ["session.json", "additional-delegations.json", "auth-requests.json"]) {
      result[name] = await fs.readFile(${JSON.stringify(join(home, ".tinycloud", "profiles", "snapshot"))} + "/" + name, "utf8");
    }
    process.stdout.write(JSON.stringify(result));
  `;

  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const layout = JSON.parse(stdout) as Record<string, string>;
    expect(layout).toEqual({
      "session.json": '{\n  "authMethod": "openkey",\n  "address": "0xOwner",\n  "chainId": 1,\n  "spaceId": "tinycloud:pkh:eip155:1:0xOwner:secrets",\n  "delegationCid": "bafy-session",\n  "verificationMethod": "did:key:session"\n}\n',
      "additional-delegations.json": '[\n  {\n    "delegation": {\n      "cid": "bafy-additional",\n      "spaceId": "tinycloud:pkh:eip155:1:0xOwner:secrets",\n      "path": "vault/secrets/KEY",\n      "actions": [\n        "tinycloud.kv/get"\n      ],\n      "delegateDID": "did:key:session",\n      "ownerAddress": "0xOwner",\n      "chainId": 1,\n      "expiry": "2099-01-01T00:00:00.000Z",\n      "delegationHeader": {\n        "Authorization": "encoded"\n      }\n    },\n    "permissions": [\n      {\n        "service": "tinycloud.kv",\n        "space": "secrets",\n        "path": "vault/secrets/KEY",\n        "actions": [\n          "tinycloud.kv/get"\n        ]\n      }\n    ]\n  }\n]\n',
      "auth-requests.json": '[\n  {\n    "kind": "tinycloud.auth.request",\n    "version": 1,\n    "requestId": "req_snapshot",\n    "createdAt": "2026-07-14T12:00:00.000Z",\n    "profile": "snapshot",\n    "posture": "delegate-session",\n    "operatorType": "agent",\n    "host": "https://node.tinycloud.test",\n    "sessionDid": "did:key:session",\n    "requested": [\n      {\n        "service": "tinycloud.kv",\n        "space": "secrets",\n        "path": "vault/secrets/KEY",\n        "actions": [\n          "tinycloud.kv/get"\n        ]\n      }\n    ]\n  }\n]\n',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reads the minimal public node-sdk auth request artifact from the request store", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-minimal-request-store-"));
  const permissionsUrl = new URL("./permissions.ts", import.meta.url).href;
  const script = `
    const {
      appendPermissionRequestArtifact,
      loadPermissionRequestArtifacts,
    } = await import(${JSON.stringify(permissionsUrl)});
    const request = {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_minimal_store",
      sessionDid: "did:key:z6MkSession",
      requested: [{
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/KEY",
        actions: ["tinycloud.kv/get"],
      }],
    };
    await appendPermissionRequestArtifact("snapshot", request);
    process.stdout.write(JSON.stringify(await loadPermissionRequestArtifacts("snapshot")));
  `;

  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_minimal_store",
      sessionDid: "did:key:z6MkSession",
      requested: [{
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/KEY",
        actions: ["tinycloud.kv/get"],
      }],
    }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reads empty requests and prior legacy request shapes from the request store", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-legacy-request-store-"));
  const permissionsUrl = new URL("./permissions.ts", import.meta.url).href;
  const script = `
    const {
      appendPermissionRequestArtifact,
      loadPermissionRequestArtifacts,
    } = await import(${JSON.stringify(permissionsUrl)});
    const requests = [
      {
        kind: "tinycloud.auth.request",
        version: 1,
        requestId: "req_empty_legacy",
        requested: [],
      },
      {
        kind: "tinycloud.auth.request",
        version: 1,
        requestId: "req_prior_cli",
        did: "did:key:z6MkLegacyRequester",
        requested: [],
        requestedExpiry: 3600,
      },
    ];
    for (const request of requests) {
      await appendPermissionRequestArtifact("snapshot", request);
    }
    process.stdout.write(JSON.stringify(await loadPermissionRequestArtifacts("snapshot")));
  `;

  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        kind: "tinycloud.auth.request",
        version: 1,
        requestId: "req_empty_legacy",
        requested: [],
      },
      {
        kind: "tinycloud.auth.request",
        version: 1,
        requestId: "req_prior_cli",
        did: "did:key:z6MkLegacyRequester",
        requested: [],
        requestedExpiry: 3600,
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps the legacy request discriminator independent of optional metadata", () => {
  expect(isCompatiblePermissionRequestArtifact({
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: "",
    requested: [],
  })).toBe(true);
  expect(isCompatiblePermissionRequestArtifact({
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: "req_prior_cli",
    did: "did:key:z6MkLegacyRequester",
    requested: [],
  })).toBe(true);
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
