import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// Keep the import-artifact characterization wired to the shipped validators.
// The rest of this file mocks persistence to isolate unrelated auth branches.
const {
  isDelegationImportArtifact: validateDelegationImportArtifact,
  isPermissionRequestArtifact: validatePermissionRequestArtifact,
} = await import("@tinycloud/operations/artifacts");

function validateCompatiblePermissionRequestArtifact(value: unknown): boolean {
  if (validatePermissionRequestArtifact(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const candidate = value as {
    kind?: unknown;
    version?: unknown;
    requestId?: unknown;
    sessionDid?: unknown;
    requested?: unknown;
  };
  return candidate.kind === "tinycloud.auth.request" &&
    candidate.version === 1 &&
    typeof candidate.requestId === "string" &&
    Array.isArray(candidate.requested);
}

type ProfileLike = {
  name: string;
  host: string;
  chainId: number;
  spaceName: string;
  did: string;
  sessionDid?: string;
  ownerDid?: string;
  spaceId?: string;
  createdAt: string;
  posture?: "owner-openkey" | "delegate-session" | "local-owner-key";
  operatorType?: "human" | "agent";
  authMethod?: "openkey" | "local";
  privateKey?: string;
  address?: string;
  openkeyHost?: string;
};

type GeneratedKey = {
  jwk: object;
  did: string;
};

type LocalSignInResult = {
  spaceId: string;
  address: string;
  chainId: number;
  delegationHeader: { Authorization: string };
  delegationCid: string;
  jwk: object;
  verificationMethod: string;
  siwe?: string;
  signature?: string;
};

type CLIErrorLike = {
  code: string;
  message: string;
  exitCode: number;
};

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  setKeys: [] as Array<{ profile: string; jwk: object }>,
  setProfiles: [] as Array<{ profile: string; data: ProfileLike }>,
  setSessions: [] as Array<{ profile: string; session: object }>,
  clearSessions: [] as string[],
  startAuthFlows: [] as Array<{
    did: string;
    options: {
      paste?: boolean;
      noPopup?: boolean;
      jwk?: object;
      host?: string;
      openkeyHost?: string;
      permissions?: unknown[];
      expiry?: string | number;
      reason?: string;
    };
  }>,
  localSignIns: [] as Array<{ privateKey: string; host: string }>,
  spinners: [] as string[],
  generateKeyCalls: 0,
  grantedRequests: [] as Array<Record<string, unknown>>,
};

let activeProfile = "default";
let activeHost = "https://node.tinycloud.test";
let profiles = new Map<string, ProfileLike>();
let keys = new Map<string, object>();
let sessions = new Map<string, object>();
let generatedKeys: GeneratedKey[] = [];
let openKeyDelegation: Record<string, unknown>;
let localSignInResult: LocalSignInResult;
let authNodeHasRuntimePermissions: boolean;
let authNodeRestorableSession: Record<string, unknown> | undefined;
let authNodeGrantDelegations: Array<{ cid: string; expiry: Date }>;
let operationInvokeHook: (() => void) | null = null;

function resetState(): void {
  recorded.outputs.length = 0;
  recorded.errors.length = 0;
  recorded.setKeys.length = 0;
  recorded.setProfiles.length = 0;
  recorded.setSessions.length = 0;
  recorded.clearSessions.length = 0;
  recorded.startAuthFlows.length = 0;
  recorded.localSignIns.length = 0;
  recorded.spinners.length = 0;
  recorded.generateKeyCalls = 0;
  recorded.grantedRequests.length = 0;

  activeProfile = "default";
  activeHost = "https://node.tinycloud.test";
  profiles = new Map();
  keys = new Map();
  sessions = new Map();
  generatedKeys = [];
  openKeyDelegation = {
    delegationHeader: { Authorization: "Bearer openkey-new" },
    delegationCid: "bafy-openkey-new",
    spaceId: "space-openkey-new",
    ownerDid: "did:pkh:eip155:1:0xowner",
    verificationMethod: "did:key:new-openkey",
    expiry: "2099-01-01T00:00:00.000Z",
  };
  localSignInResult = {
    spaceId: "space-local-new",
    address: "0xLocalOwner",
    chainId: 1,
    delegationHeader: { Authorization: "Bearer local-new" },
    delegationCid: "bafy-local-new",
    jwk: { kty: "OKP", crv: "Ed25519", x: "local-session-new", d: "local-private" },
    verificationMethod: "did:key:new-local-session",
    siwe: "local-siwe",
    signature: "0xsig",
  };
  authNodeHasRuntimePermissions = true;
  authNodeRestorableSession = undefined;
  authNodeGrantDelegations = [];
  ensureAuthenticatedError = null;
  storedImportRequest = null;
  operationRecorded.calls.length = 0;
  operationRecorded.results.length = 0;
  operationInvokeHook = null;
}

function makeProfile(overrides: Partial<ProfileLike> = {}): ProfileLike {
  return {
    name: "default",
    host: activeHost,
    chainId: 1,
    spaceName: "default",
    did: "did:key:old",
    sessionDid: "did:key:old",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({
      profile: activeProfile,
      host: activeHost,
    }),
    getProfile: async (name: string) => {
      const profile = profiles.get(name);
      if (!profile) throw new Error(`Profile "${name}" does not exist.`);
      return profile;
    },
    setProfile: async (name: string, data: ProfileLike) => {
      profiles.set(name, data);
      recorded.setProfiles.push({ profile: name, data });
    },
    getKey: async (name: string) => keys.get(name) ?? null,
    setKey: async (name: string, jwk: object) => {
      keys.set(name, jwk);
      recorded.setKeys.push({ profile: name, jwk });
    },
    getSession: async (name: string) => sessions.get(name) ?? null,
    setSession: async (name: string, session: object) => {
      sessions.set(name, session);
      recorded.setSessions.push({ profile: name, session });
    },
    clearSession: async (name: string) => {
      sessions.delete(name);
      recorded.clearSessions.push(name);
    },
  },
}));

mock.module("../auth/browser-auth.js", () => ({
  startAuthFlow: async (
    did: string,
    options: {
      paste?: boolean;
      noPopup?: boolean;
      jwk?: object;
      host?: string;
      openkeyHost?: string;
      permissions?: unknown[];
      expiry?: string | number;
    },
  ) => {
    recorded.startAuthFlows.push({ did, options });
    return openKeyDelegation;
  },
}));

mock.module("../auth/local-key.js", () => ({
  generateLocalIdentity: async () => ({
    privateKey: "0xgenerated",
    address: "0xGenerated",
    did: "did:pkh:eip155:1:0xGenerated",
  }),
  deriveAddress: async () => "0xDerived",
  addressToDID: (address: string, chainId = 1) => `did:pkh:eip155:${chainId}:${address}`,
  localKeySignIn: async (options: { privateKey: string; host: string }) => {
    recorded.localSignIns.push(options);
    return localSignInResult;
  },
  generateKey: () => {
    recorded.generateKeyCalls += 1;
    const next = generatedKeys.shift();
    if (!next) throw new Error("No generated key queued");
    return next;
  },
  keyToDID: (jwk: { did?: string }) => jwk.did ?? "did:key:from-key",
}));

mock.module("@tinycloud/node-sdk", () => ({
  grantAuthRequest: async (_node: unknown, request: Record<string, unknown>) => {
    recorded.grantedRequests.push(request);
    return { delegationCid: "bafy-granted-request" };
  },
  principalDidEquals: (left: string, right: string) =>
    left.split("#", 1)[0] === right.split("#", 1)[0],
}));

const operationRecorded = {
  calls: [] as Array<{
    operationId: string;
    operationVersion: number;
    target: Record<string, unknown>;
    input: unknown;
  }>,
  results: [] as unknown[],
};

mock.module("@tinycloud/operations", () => ({
  invokeOperation: async (
    operationId: string,
    operationVersion: number,
    target: Record<string, unknown>,
    input: unknown,
  ) => {
    operationRecorded.calls.push({ operationId, operationVersion, target, input });
    operationInvokeHook?.();
    const result = operationRecorded.results.shift();
    if (result === undefined) throw new Error("No operation result queued");
    return result;
  },
}));

let importSessionDid = "did:key:z6MkSession#z6MkSession";
const importRecorded = {
  useRuntimeDelegation: [] as Array<{ cid: string }>,
  appendedDelegations: [] as Array<{ delegation: { cid: string }; permissions: unknown[] }>,
  appendedRequests: [] as Array<Record<string, unknown>>,
  bootstrappedDelegations: [] as Array<{ cid: string }>,
};

let ensureAuthenticatedError: Error | null = null;
let storedImportRequest: Record<string, unknown> | null = null;

const importedNode = {
  hasRuntimePermissions: () => authNodeHasRuntimePermissions,
  grantRuntimePermissions: async () => authNodeGrantDelegations,
  get restorableSession() {
    return authNodeRestorableSession;
  },
  getRuntimePermissionDelegations: () => [],
  get sessionDid() {
    return importSessionDid;
  },
  useRuntimeDelegation: async (delegation: { cid: string }) => {
    importRecorded.useRuntimeDelegation.push({ cid: delegation.cid });
  },
};

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => {
    if (ensureAuthenticatedError) throw ensureAuthenticatedError;
    return importedNode;
  },
  bootstrapDelegatedSession: async (_ctx: unknown, delegation: { cid: string }) => {
    importRecorded.bootstrappedDelegations.push({ cid: delegation.cid });
    return importedNode;
  },
}));

mock.module("../lib/permissions.js", () => ({
  appendAdditionalDelegation: async (
    _profile: string,
    entry: { delegation: { cid: string }; permissions: unknown[] },
  ) => {
    importRecorded.appendedDelegations.push(entry);
  },
  appendPermissionRequestArtifact: async (_profile: string, artifact: Record<string, unknown>) => {
    importRecorded.appendedRequests.push(artifact);
  },
  createPermissionRequestArtifact: () => ({}),
  getLastPermissionRequestArtifact: async () => null,
  getPermissionRequestArtifact: async () => storedImportRequest,
  isDelegationImportArtifact: validateDelegationImportArtifact,
  isCompatiblePermissionRequestArtifact: validateCompatiblePermissionRequestArtifact,
  isPermissionRequestArtifact: validatePermissionRequestArtifact,
  appendGrantHistory: async () => {},
  compactPermission: () => "",
  loadAdditionalDelegations: async () => [],
  loadManifestPermissions: async () => [],
  loadPermissionRequest: async () => [],
  parseCapSpec: async () => ({
    service: "tinycloud.kv",
    space: "default",
    path: "",
    actions: ["list"],
  }),
  permissionsFromDelegation: () => [],
  readGrantHistory: async () => [],
  resolvePermissionSpaces: async (permissions: unknown[]) => permissions,
  storedAdditionalDelegation: (delegation: object, permissions: object[]) => ({
    delegation,
    permissions,
  }),
}));

mock.module("../output/formatter.js", () => ({
  formatField: (label: string, value: unknown) => `${label}: ${String(value)}`,
  formatTable: (_headers: string[], rows: string[][]) =>
    rows.map((row) => row.join("  ")).join("\n"),
  isInteractive: () => false,
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  shouldOutputJson: () => true,
  withSpinner: async (message: string, fn: () => unknown) => {
    recorded.spinners.push(message);
    return await fn();
  },
}));

mock.module("../output/theme.js", () => {
  const passthrough = (value: string) => value;
  return {
    theme: {
      success: passthrough,
      warn: passthrough,
      muted: passthrough,
      heading: passthrough,
      value: passthrough,
      label: passthrough,
      brand: passthrough,
    },
  };
});

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error implements CLIErrorLike {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
      public metadata?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "CLIError";
    }
  },
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
  setActiveProfileName: () => {},
}));

const {
  ensureDelegationAuthority,
  mergePrivateJwkIntoSession,
  readAuthArtifactSource,
  refreshOpenKeySession,
  registerAuthCommand,
} = await import("./auth.js");

async function runAuthCommand(args: string[]): Promise<void> {
  const program = new Command();
  registerAuthCommand(program);
  await program.parseAsync(["node", "tc", ...args], { from: "node" });
}

describe("CLI auth rotate command", () => {
  beforeEach(() => {
    resetState();
  });

  test("rotates an owner OpenKey profile key and authenticates with the new JWK", async () => {
    const oldJwk = { kty: "OKP", crv: "Ed25519", x: "old-public", d: "old-private" };
    const newJwk = { kty: "OKP", crv: "Ed25519", x: "new-public", d: "new-private" };
    profiles.set("default", makeProfile({
      ownerDid: "did:pkh:eip155:1:0xowner",
      spaceId: "space-openkey-old",
      openkeyHost: "https://openkey.test",
    }));
    keys.set("default", oldJwk);
    sessions.set("default", { delegationCid: "old-session" });
    generatedKeys.push({ jwk: newJwk, did: "did:key:new-openkey" });

    await runAuthCommand(["auth", "rotate", "--paste"]);

    expect(recorded.errors).toEqual([]);
    expect(keys.get("default")).toBe(newJwk);
    expect(recorded.clearSessions).toEqual(["default"]);
    expect(recorded.startAuthFlows).toEqual([
      {
        did: "did:key:new-openkey",
        options: expect.objectContaining({
          paste: true,
          jwk: newJwk,
          host: activeHost,
          openkeyHost: "https://openkey.test",
        }),
      },
    ]);
    expect(recorded.startAuthFlows[0]?.options.jwk).not.toBe(oldJwk);
    expect(sessions.get("default")).toEqual(openKeyDelegation);
    expect(profiles.get("default")).toEqual(expect.objectContaining({
      did: "did:key:new-openkey",
      sessionDid: "did:key:new-openkey",
      authMethod: "openkey",
      posture: "owner-openkey",
      ownerDid: "did:pkh:eip155:1:0xowner",
      spaceId: "space-openkey-new",
    }));
    expect(recorded.outputs).toEqual([
      {
        rotated: true,
        profile: "default",
        oldDid: "did:key:old",
        did: "did:key:new-openkey",
        sessionDid: "did:key:new-openkey",
        authMethod: "openkey",
        spaceId: "space-openkey-new",
      },
    ]);
  });

  test("passes --no-popup through owner OpenKey rotation", async () => {
    const oldJwk = { kty: "OKP", crv: "Ed25519", x: "old-public", d: "old-private" };
    const newJwk = { kty: "OKP", crv: "Ed25519", x: "new-public", d: "new-private" };
    profiles.set("default", makeProfile({
      ownerDid: "did:pkh:eip155:1:0xowner",
      spaceId: "space-openkey-old",
    }));
    keys.set("default", oldJwk);
    sessions.set("default", { delegationCid: "old-session" });
    generatedKeys.push({ jwk: newJwk, did: "did:key:new-openkey" });

    await runAuthCommand(["auth", "rotate", "--no-popup"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.startAuthFlows).toEqual([
      {
        did: "did:key:new-openkey",
        options: expect.objectContaining({
          noPopup: true,
          jwk: newJwk,
          host: activeHost,
        }),
      },
    ]);
  });

  test("rotates a local owner session while preserving the owner key and address", async () => {
    const oldJwk = { kty: "OKP", crv: "Ed25519", x: "old-local", d: "old-local-private" };
    const newJwk = { kty: "OKP", crv: "Ed25519", x: "new-local", d: "new-local-private" };
    profiles.set("default", makeProfile({
      did: "did:pkh:eip155:1:0xLocalOwner",
      sessionDid: "did:key:old-local-session",
      ownerDid: "did:pkh:eip155:1:0xLocalOwner",
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0xowner-private",
      address: "0xLocalOwner",
      spaceId: "space-local-old",
    }));
    keys.set("default", oldJwk);
    sessions.set("default", { delegationCid: "old-local-session" });
    generatedKeys.push({ jwk: newJwk, did: "did:key:generated-local" });

    await runAuthCommand(["auth", "rotate"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.generateKeyCalls).toBe(1);
    expect(keys.get("default")).toBe(newJwk);
    expect(keys.get("default")).not.toBe(oldJwk);
    expect(recorded.clearSessions).toEqual(["default"]);
    expect(recorded.localSignIns).toEqual([
      { privateKey: "0xowner-private", host: activeHost },
    ]);
    expect(sessions.get("default")).toEqual({
      authMethod: "local",
      address: "0xLocalOwner",
      chainId: 1,
      spaceId: "space-local-new",
      delegationHeader: { Authorization: "Bearer local-new" },
      delegationCid: "bafy-local-new",
      jwk: localSignInResult.jwk,
      verificationMethod: "did:key:new-local-session",
      siwe: "local-siwe",
      signature: "0xsig",
    });
    expect(profiles.get("default")).toEqual(expect.objectContaining({
      did: "did:pkh:eip155:1:0xLocalOwner",
      ownerDid: "did:pkh:eip155:1:0xLocalOwner",
      sessionDid: "did:key:new-local-session",
      authMethod: "local",
      privateKey: "0xowner-private",
      address: "0xLocalOwner",
      spaceId: "space-local-new",
    }));
    expect(recorded.outputs).toEqual([
      {
        rotated: true,
        profile: "default",
        oldDid: "did:key:old-local-session",
        did: "did:pkh:eip155:1:0xLocalOwner",
        sessionDid: "did:key:new-local-session",
        authMethod: "local",
        spaceId: "space-local-new",
      },
    ]);
  });

  test("rejects delegate-session profiles", async () => {
    profiles.set("default", makeProfile({
      posture: "delegate-session",
      authMethod: "openkey",
    }));
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "delegate" });

    await runAuthCommand(["auth", "rotate"]);

    expect(recorded.outputs).toEqual([]);
    expect(recorded.generateKeyCalls).toBe(0);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.localSignIns).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    const error = recorded.errors[0] as CLIErrorLike;
    expect(error.code).toBe("ROTATE_DELEGATE_SESSION_UNSUPPORTED");
    expect(error.message).toContain("Request or import a new owner delegation");
  });

  test("accepts OpenKey full space URI for a requested logical space name", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "openkey-public", d: "openkey-private" };
    profiles.set("default", makeProfile({
      did: "did:key:openkey-session",
      ownerDid: "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412",
      authMethod: "openkey",
      posture: "owner-openkey",
      openkeyHost: "https://openkey.test",
    }));
    keys.set("default", key);
    openKeyDelegation = {
      delegationHeader: { Authorization: "Bearer scoped-secrets" },
      delegationCid: "bafy-scoped-secrets",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:secrets",
      ownerDid: "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412",
      verificationMethod: "did:key:openkey-session",
      expiry: "2099-01-01T00:00:00.000Z",
    };
    const node = {
      hasRuntimePermissions: mock(() => false),
      useRuntimeDelegation: mock(async () => undefined),
    };

    await ensureDelegationAuthority({
      ctx: { profile: "default", host: activeHost },
      profile: profiles.get("default")!,
      node,
      requested: [
        {
          service: "tinycloud.kv",
          space: "secrets",
          path: "vault/secrets/",
          actions: ["tinycloud.kv/list"],
          skipPrefix: true,
        },
      ],
      expiryOption: undefined,
      reason: "Test missing capability grant.",
      yes: true,
    });

    expect(recorded.errors).toEqual([]);
    expect(recorded.startAuthFlows).toHaveLength(1);
    expect(recorded.startAuthFlows[0]).toEqual({
      did: "did:key:openkey-session",
      options: expect.objectContaining({
        jwk: key,
        host: activeHost,
        openkeyHost: "https://openkey.test",
        reason: expect.stringContaining("Test missing capability grant."),
        permissions: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/",
            actions: ["tinycloud.kv/list"],
            skipPrefix: true,
          },
        ],
      }),
    });
    expect(node.useRuntimeDelegation).toHaveBeenCalledWith(expect.objectContaining({
      cid: "bafy-scoped-secrets",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:secrets",
      path: "vault/secrets/",
      actions: ["tinycloud.kv/list"],
      resources: [
        expect.objectContaining({
          service: "kv",
          space: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:secrets",
          path: "vault/secrets/",
          actions: ["tinycloud.kv/list"],
        }),
      ],
    }));
  });
});

function makePortableDelegation(overrides: { delegateDID: string; cid?: string }): Record<string, unknown> {
  return {
    cid: overrides.cid ?? "bafy-import-delegation",
    spaceId: "tinycloud:pkh:eip155:1:0xOwner:secrets",
    path: "vault/secrets/ANTHROPIC_API_KEY",
    actions: ["tinycloud.kv/get"],
    delegateDID: overrides.delegateDID,
    ownerAddress: "0xOwner",
    chainId: 1,
    delegationHeader: { Authorization: "Bearer import-delegation" },
    expiry: "2099-01-01T00:00:00.000Z",
  };
}

function makeStoredImportRequest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: "req_v1",
    createdAt: "2026-07-14T12:00:00.000Z",
    profile: "default",
    posture: "delegate-session",
    operatorType: "agent",
    host: activeHost,
    sessionDid: "did:key:z6MkSession",
    requested: [{
      service: "tinycloud.kv",
      space: "tinycloud:pkh:eip155:1:0xOwner:secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/get"],
    }],
    ...overrides,
  };
}

describe("CLI auth import command", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetState();
    importRecorded.useRuntimeDelegation.length = 0;
    importRecorded.appendedDelegations.length = 0;
    importRecorded.appendedRequests.length = 0;
    importRecorded.bootstrappedDelegations.length = 0;
    ensureAuthenticatedError = null;
    importSessionDid = "did:key:z6MkSession#z6MkSession";
    tempDir = await mkdtemp(join(tmpdir(), "tc-auth-import-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function expectCanonicalOperationRejection(
    artifact: Record<string, unknown>,
    code: string,
  ): Promise<void> {
    storedImportRequest = makeStoredImportRequest();
    operationRecorded.results.push({
      status: "error",
      error: { code, message: "Canonical operation rejection.", retryable: false },
    });
    const source = join(tempDir, `${code}.json`);
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code, exitCode: 1 });
    expect(operationRecorded.calls).toEqual([{
      operationId: "tinycloud.auth.import",
      operationVersion: 1,
      target: { profile: "default", host: activeHost, allowOwnerProfile: true },
      input: artifact,
    }]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.localSignIns).toEqual([]);
    expect(authNodeGrantDelegations).toEqual([]);
  }

  test("persists a cross-user delegation without installing it as a runtime grant", async () => {
    // Audience is the importer's stable identity DID (did:pkh), not the session
    // key. The node would reject this via useRuntimeDelegation, so import must
    // persist it for later activation through useDelegation.
    const delegation = makePortableDelegation({
      delegateDID: "did:pkh:eip155:1:0xAgent",
      cid: "bafy-cross-user",
    });
    const source = join(tempDir, "cross-user.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.appendedDelegations).toHaveLength(1);
    expect(importRecorded.appendedDelegations[0].delegation.cid).toBe("bafy-cross-user");
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      imported: true,
      activated: false,
      delegationCid: "bafy-cross-user",
    });
  });

  test("installs a delegation that targets the active session key as a runtime grant", async () => {
    const delegation = makePortableDelegation({
      delegateDID: "did:key:z6MkSession",
      cid: "bafy-self-session",
    });
    const source = join(tempDir, "self-session.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.appendedDelegations).toHaveLength(1);
    expect(importRecorded.useRuntimeDelegation).toEqual([{ cid: "bafy-self-session" }]);
    expect(recorded.outputs[0]).toMatchObject({
      imported: true,
      activated: true,
      delegationCid: "bafy-self-session",
    });
  });

  test("bootstraps a fresh delegate-session profile from its first imported delegation", async () => {
    profiles.set("default", makeProfile({ posture: "delegate-session" }));
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "delegate", d: "private" });
    ensureAuthenticatedError = new Error("Not authenticated");
    const delegation = makePortableDelegation({
      delegateDID: "did:key:z6MkSession",
      cid: "bafy-first-delegation",
    });
    const source = join(tempDir, "first-delegation.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([{ cid: "bafy-first-delegation" }]);
    expect(importRecorded.useRuntimeDelegation).toEqual([{ cid: "bafy-first-delegation" }]);
    expect(recorded.outputs[0]).toMatchObject({ imported: true, activated: true });
  });

  test("routes a v1 delegation artifact with an optional host and requestId canonically", async () => {
    storedImportRequest = makeStoredImportRequest();
    operationRecorded.results.push({
      status: "ok",
      operation: { operationId: "tinycloud.auth.import", operationVersion: 1 },
      context: { profile: "default", host: activeHost, posture: "delegate-session" },
      output: {
        cid: "bafy-v1-artifact",
        effectivePermissions: storedImportRequest.requested,
        expiry: "2099-01-01T00:00:00.000Z",
        activated: true,
      },
    });
    const source = join(tempDir, "v1-artifact.json");
    await writeFile(source, JSON.stringify({
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: makePortableDelegation({ delegateDID: "did:key:z6MkSession", cid: "bafy-v1-artifact" }),
    }), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(operationRecorded.calls).toHaveLength(1);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({ requestId: "req_v1", delegationCid: "bafy-v1-artifact", activated: true });
  });

  test("fails closed without persistence when a v1 request-bound artifact is unknown", async () => {
    const source = join(tempDir, "unmatched-cross-user-v1.json");
    await writeFile(source, JSON.stringify({
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_for_another_profile",
      delegation: makePortableDelegation({
        delegateDID: "did:pkh:eip155:1:0xOtherUser",
        cid: "bafy-unmatched-cross-user",
      }),
    }), "utf8");

    operationRecorded.results.push({
      status: "error",
      error: {
        code: "DELEGATION_ARTIFACT_INVALID",
        message: "The delegation does not reference a stored request for this profile.",
        retryable: false,
      },
    });

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code: "DELEGATION_ARTIFACT_INVALID", exitCode: 1 });
    expect(operationRecorded.calls).toHaveLength(1);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
  });

  test("keeps a genuinely unbound v1 envelope on the documented legacy path", async () => {
    const source = join(tempDir, "unbound-v1.json");
    await writeFile(source, JSON.stringify({
      kind: "tinycloud.auth.delegation",
      version: 1,
      delegation: makePortableDelegation({
        delegateDID: "did:pkh:eip155:1:0xOtherUser",
        cid: "bafy-unbound-legacy",
      }),
    }), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(operationRecorded.calls).toEqual([]);
    expect(importRecorded.appendedDelegations).toHaveLength(1);
    expect(recorded.outputs[0]).toMatchObject({
      requestId: null,
      delegationCid: "bafy-unbound-legacy",
      activated: false,
    });
  });

  test("routes a request-bound v1 delegation through invokeOperation", async () => {
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: makePortableDelegation({
        delegateDID: "did:key:z6MkSession",
        cid: "bafy-operation-import",
      }),
    };
    storedImportRequest = makeStoredImportRequest();
    operationRecorded.results.push({
      status: "ok",
      operation: { operationId: "tinycloud.auth.import", operationVersion: 1 },
      context: { profile: "default", host: activeHost, posture: "delegate-session" },
      output: {
        cid: "bafy-operation-import",
        effectivePermissions: storedImportRequest.requested,
        expiry: "2099-01-01T00:00:00.000Z",
        audience: "did:key:z6MkSession",
        activated: true,
        alreadyPresent: false,
      },
    });
    const source = join(tempDir, "bound-v1-artifact.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(operationRecorded.calls).toEqual([{
      operationId: "tinycloud.auth.import",
      operationVersion: 1,
      target: { profile: "default", host: activeHost, allowOwnerProfile: true },
      input: artifact,
    }]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.outputs).toEqual([{
      imported: true,
      activated: true,
      kind: "tinycloud.auth.delegation",
      requestId: "req_v1",
      delegationCid: "bafy-operation-import",
      permissions: storedImportRequest.requested,
      expiry: "2099-01-01T00:00:00.000Z",
    }]);
  });

  test("routes a wrong-host request-bound envelope through the canonical operation", async () => {
    await expectCanonicalOperationRejection({
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      permissions: [{ service: "tinycloud.kv", space: "forged", path: "forged", actions: ["tinycloud.kv/*"] }],
      delegation: {
        ...makePortableDelegation({ delegateDID: "did:key:z6MkSession" }),
        host: "https://wrong-host.tinycloud.test",
      },
    }, "DELEGATION_HOST_MISMATCH");
  });

  test("routes a stale-session request-bound envelope through the canonical operation", async () => {
    importSessionDid = "did:key:z6MkRotatedSession";
    storedImportRequest = makeStoredImportRequest({ sessionDid: "did:key:z6MkSession" });
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: makePortableDelegation({ delegateDID: "did:key:z6MkSession" }),
    };
    operationRecorded.results.push({
      status: "error",
      error: { code: "STALE_SESSION", message: "Canonical operation rejection.", retryable: false },
    });
    const source = join(tempDir, "stale-session.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code: "STALE_SESSION", exitCode: 1 });
    expect(operationRecorded.calls).toHaveLength(1);
    expect(operationRecorded.calls[0]?.input).toEqual(artifact);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.localSignIns).toEqual([]);
    expect(authNodeGrantDelegations).toEqual([]);
  });

  test("routes a wrong-audience request-bound envelope through the canonical operation", async () => {
    await expectCanonicalOperationRejection({
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: makePortableDelegation({ delegateDID: "did:key:z6MkOtherSession" }),
    }, "DELEGATION_AUDIENCE_MISMATCH");
  });

  test("routes a malformed request-bound envelope unchanged through the canonical operation", async () => {
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: null,
      permissions: [{ service: "tinycloud.kv", space: "forged", path: "forged", actions: ["tinycloud.kv/*"] }],
    };

    await expectCanonicalOperationRejection(artifact, "INVALID_AUTH_IMPORT");
  });

  test("routes a malformed empty-ID request-bound envelope through the canonical operation", async () => {
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "",
      delegation: null,
      permissions: [{ service: "tinycloud.kv", space: "forged", path: "forged", actions: ["tinycloud.kv/*"] }],
    };
    storedImportRequest = makeStoredImportRequest({ requestId: "" });
    operationRecorded.results.push({
      status: "error",
      error: { code: "INVALID_AUTH_IMPORT", message: "Canonical operation rejection.", retryable: false },
    });
    const source = join(tempDir, "empty-id-malformed-v1-artifact.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code: "INVALID_AUTH_IMPORT", exitCode: 1 });
    expect(operationRecorded.calls).toEqual([{
      operationId: "tinycloud.auth.import",
      operationVersion: 1,
      target: { profile: "default", host: activeHost, allowOwnerProfile: true },
      input: artifact,
    }]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.localSignIns).toEqual([]);
    expect(authNodeGrantDelegations).toEqual([]);
  });

  test("keeps a request-bound envelope on the canonical operation path after request deletion", async () => {
    storedImportRequest = makeStoredImportRequest();
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: makePortableDelegation({ delegateDID: "did:key:z6MkSession" }),
    };
    operationInvokeHook = () => {
      storedImportRequest = null;
    };
    operationRecorded.results.push({
      status: "error",
      error: { code: "REQUEST_NOT_FOUND", message: "Request was deleted.", retryable: false },
    });
    const source = join(tempDir, "request-deleted.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(storedImportRequest).toBeNull();
    expect(recorded.errors.pop()).toMatchObject({ code: "REQUEST_NOT_FOUND", exitCode: 1 });
    expect(operationRecorded.calls).toHaveLength(1);
    expect(operationRecorded.calls[0]?.input).toEqual(artifact);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.localSignIns).toEqual([]);
    expect(authNodeGrantDelegations).toEqual([]);
  });

  test("maps every non-success operation outcome without escalating a delegate session", async () => {
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_v1",
      delegation: makePortableDelegation({ delegateDID: "did:key:z6MkSession" }),
    };
    storedImportRequest = makeStoredImportRequest();
    const source = join(tempDir, "operation-outcome.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    operationRecorded.results.push({
      status: "authority_required",
      request: makeStoredImportRequest(),
      missing: [],
    });
    await runAuthCommand(["auth", "import", source]);
    expect(recorded.errors.pop()).toMatchObject({ code: "AUTHORITY_REQUIRED", exitCode: 5 });

    operationRecorded.results.push({
      status: "setup_required",
      setup: { kind: "test" },
    });
    await runAuthCommand(["auth", "import", source]);
    expect(recorded.errors.pop()).toMatchObject({ code: "SETUP_REQUIRED", exitCode: 1 });

    operationRecorded.results.push({
      status: "error",
      error: { code: "DELEGATION_REJECTED", message: "The delegation was rejected.", retryable: false },
    });
    await runAuthCommand(["auth", "import", source]);
    expect(recorded.errors.pop()).toMatchObject({ code: "DELEGATION_REJECTED", exitCode: 1 });

    expect(operationRecorded.calls).toHaveLength(3);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(authNodeGrantDelegations).toEqual([]);
    expect(importRecorded.appendedDelegations).toEqual([]);
  });

  test("accepts a stored delegation wrapper from the legacy on-disk shape", async () => {
    const source = join(tempDir, "stored-wrapper.json");
    await writeFile(source, JSON.stringify({
      delegation: makePortableDelegation({ delegateDID: "did:key:z6MkSession", cid: "bafy-stored-wrapper" }),
      permissions: [{
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0xOwner:secrets",
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
      }],
    }), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.appendedDelegations[0]?.permissions).toEqual([
      expect.objectContaining({ service: "tinycloud.kv", path: "vault/secrets/ANTHROPIC_API_KEY" }),
    ]);
    expect(recorded.outputs[0]).toMatchObject({ delegationCid: "bafy-stored-wrapper", activated: true });
  });

  test("accepts a v1 permission artifact without the legacy command field", async () => {
    const source = join(tempDir, "v1-request.json");
    await writeFile(source, JSON.stringify({
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_without_command",
      createdAt: "2026-07-14T12:00:00.000Z",
      profile: "default",
      posture: "delegate-session",
      operatorType: "agent",
      host: activeHost,
      sessionDid: "did:key:z6MkSession",
      requested: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] }],
    }), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.appendedRequests).toHaveLength(1);
    expect(importRecorded.appendedRequests[0]).not.toHaveProperty("command");
    expect(recorded.outputs[0]).toEqual({
      imported: true,
      kind: "tinycloud.auth.request",
      requestId: "req_without_command",
      requested: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] }],
      next: "tc auth retry req_without_command",
    });
  });

  test("grants a canonical v1 request that omits command", async () => {
    profiles.set("default", makeProfile({
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0xowner",
    }));
    const request = makeStoredImportRequest({
      posture: "delegate-session",
      operatorType: "agent",
    });
    const source = join(tempDir, "request-without-command.json");
    await writeFile(source, JSON.stringify(request), "utf8");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.grantedRequests).toHaveLength(1);
    expect(recorded.grantedRequests[0]).not.toHaveProperty("command");
  });

  test("imports the minimal public node-sdk auth request artifact", async () => {
    const request = {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_minimal_import",
      sessionDid: "did:key:z6MkSession",
      requested: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] }],
    };
    const source = join(tempDir, "minimal-request.json");
    await writeFile(source, JSON.stringify(request), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.appendedRequests).toEqual([request]);
    expect(recorded.outputs[0]).toEqual({
      imported: true,
      kind: "tinycloud.auth.request",
      requestId: "req_minimal_import",
      requested: request.requested,
      next: "tc auth retry req_minimal_import",
    });
  });

  test("imports an empty legacy request with older optional metadata", async () => {
    const request = {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_empty_legacy",
      did: "did:key:z6MkLegacyRequester",
      requested: [],
    };
    const source = join(tempDir, "empty-legacy-request.json");
    await writeFile(source, JSON.stringify(request), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.appendedRequests).toEqual([request]);
    expect(recorded.outputs[0]).toEqual({
      imported: true,
      kind: "tinycloud.auth.request",
      requestId: "req_empty_legacy",
      requested: [],
      next: "tc auth retry req_empty_legacy",
    });
  });

  test("grants the minimal public node-sdk auth request artifact", async () => {
    profiles.set("default", makeProfile());
    const request = {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_minimal_grant",
      sessionDid: "did:key:z6MkSession",
      requested: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] }],
    };
    const source = join(tempDir, "minimal-grant.json");
    await writeFile(source, JSON.stringify(request), "utf8");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.grantedRequests).toEqual([request]);
  });
});

describe("CLI auth artifact sources", () => {
  test("retains file, stdin, and URL source parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-auth-source-"));
    const artifact = '{"kind":"tinycloud.auth.delegation"}';
    const path = join(directory, "artifact.json");
    await writeFile(path, artifact, "utf8");
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(artifact);
    });
    let listening = false;
    try {
      expect(await readAuthArtifactSource(path, { stdin: false })).toBe(artifact);

      Object.defineProperty(process, "stdin", {
        configurable: true,
        value: Readable.from([artifact]),
      });
      expect(await readAuthArtifactSource(undefined, { stdin: true })).toBe(artifact);

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      listening = true;
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP listener");
      expect(await readAuthArtifactSource(`http://127.0.0.1:${address.port}/artifact.json`, { stdin: false })).toBe(artifact);
    } finally {
      if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
      if (listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("owner OpenKey acquisition seam", () => {
  test("uses one explicit acquisition function without a live OpenKey service", async () => {
    const profile = makeProfile({ did: "did:pkh:eip155:1:0xOwner", authMethod: "openkey", posture: "owner-openkey" });
    profiles.set("default", profile);
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "owner", d: "private" });
    authNodeHasRuntimePermissions = false;
    let acquisitions = 0;

    await ensureDelegationAuthority({
      ctx: { profile: "default", host: activeHost },
      profile,
      node: importedNode,
      requested: [{ service: "tinycloud.kv", space: "space-openkey-new", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] }],
      expiryOption: undefined,
      reason: "I0 seam test",
      yes: true,
      openKeyAcquisition: async () => {
        acquisitions += 1;
        return openKeyDelegation;
      },
    });

    expect(acquisitions).toBe(1);
    expect(importRecorded.useRuntimeDelegation).toEqual([{ cid: "bafy-openkey-new" }]);
  });
});

describe("mergePrivateJwkIntoSession (write-side JWK sanitization)", () => {
  const FULL_KEY = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };

  test("splices `d` from key.json into a public-only session JWK", () => {
    const session = {
      delegationCid: "bafy",
      spaceId: "tinycloud:space",
      jwk: { kty: "OKP", crv: "Ed25519", x: "session-public" },
    };
    const merged = mergePrivateJwkIntoSession(session, FULL_KEY);
    expect((merged.jwk as { d?: string }).d).toBe("key-private");
    // Keeps everything else
    expect((merged.jwk as { x?: string }).x).toBe("session-public");
    expect(merged.spaceId).toBe("tinycloud:space");
  });

  test("does not overwrite a session JWK that already has `d`", () => {
    const sessionJwk = { kty: "OKP", crv: "Ed25519", x: "session-public", d: "session-private" };
    const session = { delegationCid: "bafy", jwk: sessionJwk };
    const merged = mergePrivateJwkIntoSession(session, FULL_KEY);
    expect((merged.jwk as { d?: string }).d).toBe("session-private");
  });

  test("returns the session unchanged when no `jwk` field is present", () => {
    const session = { delegationCid: "bafy", spaceId: "tinycloud:space" };
    const merged = mergePrivateJwkIntoSession(session, FULL_KEY);
    expect(merged).toBe(session);
  });
});

describe("CLI auth request command", () => {
  beforeEach(() => {
    resetState();
  });

  test("persists the active local session after granting runtime permissions", async () => {
    const sessionJwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: "runtime-session",
      d: "runtime-private",
    };
    profiles.set("default", makeProfile({
      did: "did:pkh:eip155:1:0xLocalOwner",
      sessionDid: "did:key:old-local-session",
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0xowner-private",
      address: "0xLocalOwner",
      spaceId: "space-local-old",
    }));
    sessions.set("default", {
      authMethod: "local",
      address: "0xLocalOwner",
      chainId: 1,
      spaceId: "space-local-old",
    });
    authNodeHasRuntimePermissions = false;
    authNodeGrantDelegations = [
      { cid: "bafy-runtime-grant", expiry: new Date("2099-01-01T00:00:00.000Z") },
    ];
    authNodeRestorableSession = {
      address: "0xLocalOwner",
      chainId: 1,
      sessionKey: JSON.stringify(sessionJwk),
      spaceId: "space-local-new",
      delegationHeader: { Authorization: "Bearer runtime-session" },
      delegationCid: "bafy-runtime-session",
      jwk: sessionJwk,
      verificationMethod: "did:key:runtime-session",
      siwe: "runtime-siwe",
      signature: "0xruntime",
    };

    await runAuthCommand([
      "auth",
      "request",
      "--grant",
      "--yes",
      "--cap",
      "tinycloud.kv:default/:list",
    ]);

    expect(recorded.errors).toEqual([]);
    expect(sessions.get("default")).toEqual({
      authMethod: "local",
      address: "0xLocalOwner",
      chainId: 1,
      spaceId: "space-local-new",
      delegationHeader: { Authorization: "Bearer runtime-session" },
      delegationCid: "bafy-runtime-session",
      jwk: sessionJwk,
      verificationMethod: "did:key:runtime-session",
      siwe: "runtime-siwe",
      signature: "0xruntime",
    });
    expect(profiles.get("default")).toEqual(expect.objectContaining({
      sessionDid: "did:key:runtime-session",
      spaceId: "space-local-new",
    }));
    expect(recorded.outputs).toEqual([
      expect.objectContaining({
        changed: true,
        delegationCid: "bafy-runtime-grant",
        delegationCids: ["bafy-runtime-grant"],
        expiry: "2099-01-01T00:00:00.000Z",
      }),
    ]);
  });
});

describe("refreshOpenKeySession sanitizes persisted session JWK", () => {
  beforeEach(() => {
    resetState();
  });

  test("when OpenKey returns a public-only JWK, persisted session.json has `d` merged in from key.json", async () => {
    const fullKey = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
    profiles.set("default", makeProfile({
      did: "did:key:z6MkSession",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    keys.set("default", fullKey);
    openKeyDelegation = {
      delegationHeader: { Authorization: "Bearer openkey-new" },
      delegationCid: "bafy-openkey",
      spaceId: "tinycloud:space",
      ownerDid: "did:pkh:eip155:1:0xowner",
      verificationMethod: "did:key:z6MkSession",
      expiry: "2099-01-01T00:00:00.000Z",
      // The public-only JWK OpenKey echoes back (public-only because
      // browser-auth.ts strips `d` before sending to OpenKey).
      jwk: { kty: "OKP", crv: "Ed25519", x: "key-public" },
    };

    await refreshOpenKeySession("default", activeHost);

    const persisted = sessions.get("default") as { jwk: { d?: string; x?: string } };
    expect(persisted).toBeDefined();
    expect(persisted.jwk.d).toBe("key-private");
    expect(persisted.jwk.x).toBe("key-public");
  });

  test("when OpenKey returns a full JWK (with `d`), persisted session.json keeps OpenKey's `d`", async () => {
    const fullKey = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
    profiles.set("default", makeProfile({
      did: "did:key:z6MkSession",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    keys.set("default", fullKey);
    openKeyDelegation = {
      delegationHeader: { Authorization: "Bearer openkey-new" },
      delegationCid: "bafy-openkey",
      spaceId: "tinycloud:space",
      ownerDid: "did:pkh:eip155:1:0xowner",
      verificationMethod: "did:key:z6MkSession",
      expiry: "2099-01-01T00:00:00.000Z",
      jwk: { kty: "OKP", crv: "Ed25519", x: "key-public", d: "openkey-returned-private" },
    };

    await refreshOpenKeySession("default", activeHost);

    const persisted = sessions.get("default") as { jwk: { d?: string } };
    expect(persisted.jwk.d).toBe("openkey-returned-private");
  });
});
