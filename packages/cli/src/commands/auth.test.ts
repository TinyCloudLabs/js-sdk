import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { profilePath, withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { DEFAULT_HOST } from "../config/constants.js";

const testHome = await mkdtemp(join(tmpdir(), "tc858-auth-mocks-"));
afterAll(async () => { await rm(testHome, { recursive: true, force: true }); });
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
  ownerKeyPrimary?: boolean;
  spaceId?: string;
  createdAt: string;
  posture?: "owner-openkey" | "delegate-session" | "local-owner-key";
  operatorType?: "human" | "agent";
  authMethod?: "openkey" | "local";
  privateKey?: string;
  address?: string;
  authSignedOut?: boolean;
  replication?: { prefixes: string[]; allowSecrets?: boolean };
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
  replicaRemovalError: null as Error | null,
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
  grantedExpiries: [] as Array<number | undefined>,
  grantHistory: [] as Array<{ profile: string; entry: Record<string, unknown> }>,
  localGrantArtifacts: [] as Array<{ profile: string; delegation: Record<string, unknown> }>,
  removedReplicaProfiles: [] as string[],
};

const grantedDelegation = {
  cid: "bafy-granted-request",
  spaceId: "tinycloud:pkh:eip155:1:0xOwner:secrets",
  path: "vault/secrets/ANTHROPIC_API_KEY",
  actions: ["tinycloud.kv/get"],
  delegateDID: "did:key:z6MkRequester",
  delegationHeader: { Authorization: "Bearer signed-grant-artifact" },
  expiry: "2099-01-01T00:00:00.000Z",
};

let activeProfile = "default";
let activeHost = "https://node.tinycloud.test";
let profiles = new Map<string, ProfileLike>();
let keys = new Map<string, object>();
let sessions = new Map<string, object>();
let generatedKeys: GeneratedKey[] = [];
let manifestPermissions: unknown[] = [];
let openKeyDelegation: Record<string, unknown>;
// When set, the OpenKey approval is abandoned: the flow rejects before any grant exists.
let startAuthFlowFailure: Error | null = null;
let localSignInResult: LocalSignInResult;
let authNodeHasRuntimePermissions: boolean;
let authNodeRestorableSession: Record<string, unknown> | undefined;
let authNodeGrantDelegations: Array<{ cid: string; expiry: Date }>;
let onGrantRuntimePermissions: (() => void | Promise<void>) | null = null;
let operationInvokeHook: (() => void) | null = null;
// What `restoreProfileSessionNode` returns; null: no restorable session.
let restoredSessionNode: ((ctx: unknown) => unknown) | null = null;

function resetState(): void {
  recorded.outputs.length = 0;
  recorded.errors.length = 0;
  recorded.setKeys.length = 0;
  recorded.setProfiles.length = 0;
  recorded.setSessions.length = 0;
  recorded.clearSessions.length = 0;
  recorded.replicaRemovalError = null;
  recorded.startAuthFlows.length = 0;
  recorded.localSignIns.length = 0;
  recorded.spinners.length = 0;
  recorded.generateKeyCalls = 0;
  recorded.grantedRequests.length = 0;
  recorded.grantedExpiries.length = 0;
  recorded.localGrantArtifacts.length = 0;
  recorded.removedReplicaProfiles.length = 0;
  recorded.grantHistory.length = 0;

  activeProfile = "default";
  activeHost = "https://node.tinycloud.test";
  profiles = new Map();
  keys = new Map();
  sessions = new Map();
  generatedKeys = [];
  startAuthFlowFailure = null;
  manifestPermissions = [];
  openKeyDelegation = {
    delegationHeader: { Authorization: "Bearer openkey-new" },
    delegationCid: "bafy-openkey-new",
    spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
    ownerDid: "did:pkh:eip155:1:0xowner",
    verificationMethod: "did:key:new-openkey",
    expiry: "2099-01-01T00:00:00.000Z",
    // OpenKey always returns its SIWE proof; the wasm verifier below stands in for checking it.
    siwe: "siwe-message",
    signature: "0xsignature",
    address: "0xowner",
    chainId: 1,
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
  onGrantRuntimePermissions = null;
  ensureAuthenticatedError = null;
  storedImportRequest = null;
  operationRecorded.calls.length = 0;
  operationRecorded.results.length = 0;
  operationInvokeHook = null;
  restoredSessionNode = null;
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
    // Real logins commit under the profile lock; these mocks keep state in memory.
    updateProfile: async (name: string, update: (profile: ProfileLike) => ProfileLike) => {
      const current = profiles.get(name);
      if (!current) throw new Error(`Profile "${name}" does not exist.`);
      const next = update(current);
      profiles.set(name, next);
      recorded.setProfiles.push({ profile: name, data: next });
      return next;
    },
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    getCacheDir: async (name: string) => join(testHome, "cache", name),
    profileExists: async (name: string) => profiles.has(name),
    ensureConfigDir: async () => {},
    getConfig: async () => ({ defaultProfile: "default" }),
    setConfig: async () => {},
    resolveContext: async () => ({
      profile: activeProfile,
      host: activeHost,
    }),
    getProfile: async (name: string) => {
      const profile = profiles.get(name);
      if (!profile) {
        // Same code as the real ProfileManager, so callers can tell a missing profile apart.
        const { CLIError } = await import("../output/errors.js");
        throw new CLIError("PROFILE_NOT_FOUND", `Profile "${name}" does not exist. Create it with \`tc init --key-only --name ${name}\`.`, 1);
      }
      return profile;
    },
    setProfile: async (name: string, data: ProfileLike) => {
      profiles.set(name, data);
      recorded.setProfiles.push({ profile: name, data });
    },
    setProfileDurable: async (name: string, data: ProfileLike) => {
      profiles.set(name, data);
      recorded.setProfiles.push({ profile: name, data });
    },
    getKey: async (name: string) => keys.get(name) ?? null,
    setKey: async (name: string, jwk: object) => {
      keys.set(name, jwk);
      recorded.setKeys.push({ profile: name, jwk });
    },
    removeKey: async (name: string) => { keys.delete(name); },
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
mock.module("../lib/profile-replicas.js", () => ({
  removeProfileReplicas: async (profile: string) => {
    if (recorded.replicaRemovalError) throw recorded.replicaRemovalError;
    recorded.removedReplicaProfiles.push(profile);
    return ["notes"];
  },
}));

mock.module("../auth/browser-auth.js", () => ({
  publicJwkForDelegation: (jwk: Record<string, unknown>) => {
    const { d: _privateKey, ...publicJwk } = jwk;
    return publicJwk;
  },
  validateDelegationCallbackPayload: () => null,
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
    if (startAuthFlowFailure) throw startAuthFlowFailure;
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

const { TinyCloudNode, REPLICA_LOGOUT_PENDING_FILE, NodeWasmBindings: RealNodeWasmBindings } = await import("@tinycloud/node-sdk");

mock.module("@tinycloud/node-sdk", () => ({
  TinyCloudNode,
  REPLICA_LOGOUT_PENDING_FILE,
  grantAuthRequest: async (_node: unknown, request: Record<string, unknown>, options?: { expiry?: number }) => {
    recorded.grantedRequests.push(request);
    recorded.grantedExpiries.push(options?.expiry);
    return {
      delegationCid: grantedDelegation.cid,
      delegation: grantedDelegation,
      permissions: request.requested,
      expiry: "2099-01-01T00:00:00.000Z",
    };
  },
  principalDidEquals: (left: string, right: string) =>
    left.split("#", 1)[0] === right.split("#", 1)[0],
  // Signature checks run against real proofs in auth/scoped-login.test.ts and
  // auth/device-auth.test.ts; here any structurally complete proof verifies.
  NodeWasmBindings: class NodeWasmBindings extends RealNodeWasmBindings {
    validatePersistedSession(proof: { spaceId: string }) {
      return {
        verifiedRecap: [
          ...(openKeyDelegation.kvUnchecked === true ? [] : [{ service: "kv", space: proof.spaceId, path: typeof openKeyDelegation.verifiedPath === "string" ? openKeyDelegation.verifiedPath : "", actions: ["tinycloud.kv/get"] }]),
          { service: "capabilities", space: proof.spaceId, path: "", actions: ["tinycloud.capabilities/read"] },
        ],
        expiresAt: typeof openKeyDelegation.expiry === "string" ? openKeyDelegation.expiry : "2099-01-01T00:00:00.000Z",
      };
    }
  },
  signedCompactUcanExpiry: () => undefined,
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
    // Every real result envelope reports the invocation context.
    return { context: { profile: "default", host: "https://node.example", posture: "delegate-session" }, ...result };
  },
}));

let importSessionDid = "did:key:z6MkSession#z6MkSession";
const importRecorded = {
  useRuntimeDelegation: [] as Array<{ cid: string }>,
  appendedDelegations: [] as Array<{ delegation: { cid: string }; permissions: unknown[] }>,
  appendedRequests: [] as Array<Record<string, unknown>>,
  bootstrappedDelegations: [] as Array<{ cid: string }>,
  abandonedBootstraps: [] as unknown[],
};

let ensureAuthenticatedError: Error | null = null;
let storedImportRequest: Record<string, unknown> | null = null;
let bootstrapDelegatedSessionError: Error | null = null;

const importedNode = {
  hasRuntimePermissions: () => authNodeHasRuntimePermissions,
  grantRuntimePermissions: async () => {
    await onGrantRuntimePermissions?.();
    return authNodeGrantDelegations;
  },
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
    if (bootstrapDelegatedSessionError) throw bootstrapDelegatedSessionError;
    return {
      node: importedNode,
      abandon: async (cause: unknown) => {
        importRecorded.abandonedBootstraps.push(cause);
        throw cause;
      },
    };
  },
  restoreProfileSessionNode: async (ctx: unknown) =>
    restoredSessionNode ? restoredSessionNode(ctx) : { unavailable: "session_missing" as const },
}));

mock.module("../lib/permissions.js", () => ({
  appendLocalGrantArtifact: async (profile: string, delegation: Record<string, unknown>) => {
    recorded.localGrantArtifacts.push({ profile, delegation });
  },
  appendAdditionalDelegation: async (
    _profile: string,
    entry: { delegation: { cid: string }; permissions: unknown[] },
  ) => {
    importRecorded.appendedDelegations.push(entry);
  },
  appendAdditionalDelegationIfUnexpired: async (
    _profile: string,
    entry: { delegation: { cid: string }; permissions: unknown[] },
  ) => {
    importRecorded.appendedDelegations.push(entry);
    return true;
  },
  appendAdditionalDelegations: async (
    _profile: string,
    entries: Array<{ delegation: { cid: string }; permissions: unknown[] }>,
  ) => {
    importRecorded.appendedDelegations.push(...entries);
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
  appendGrantHistory: async (profile: string, entry: Record<string, unknown>) => {
    recorded.grantHistory.push({ profile, entry });
  },
  cliGrantRecord: async (_node: unknown, delegation: object, permissions: object[]) => ({ delegation, permissions }),
  compactPermission: () => "",
  loadLocalGrantArtifacts: async () => [],
  removeStoredDelegations: async () => 0,
  loadAdditionalDelegations: async () => [],
  loadManifestPermissions: async () => manifestPermissions as never,
  loadPermissionRequest: async () => [],
  parseCapSpec: async (spec: string) => spec.includes(":account:")
    ? { service: "tinycloud.kv", space: "account", path: "applications/", actions: ["get"] }
    : {
      service: "tinycloud.kv",
      space: "default",
      path: "",
      actions: ["list"],
    },
  permissionsFromDelegation: () => [],
  readGrantHistory: async () => [],
  // Like the real resolver: a space name becomes the owner's space id.
  resolvePermissionSpaces: async (permissions: Array<{ space?: string }>) =>
    permissions.map((permission) => ({
      ...permission,
      space: permission.space === undefined || permission.space.startsWith("tinycloud:")
        ? permission.space
        : `tinycloud:pkh:eip155:1:0xOwner:${permission.space}`,
    })),
  storedAdditionalDelegation: (delegation: object, permissions: object[]) => ({
    delegation,
    permissions,
  }),
}));

mock.module("../output/formatter.js", () => ({
  // Warning rendering is covered end to end in stored-grant-warnings.test.ts.
  operationWarnings: (value: unknown) => (Array.isArray(value) ? value : []),
  outputWarnings: () => {},
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
  cliErrorFromService: (error: { code: string; message: string; meta?: Record<string, unknown> }) =>
    Object.assign(new Error(error.message), { code: error.code, exitCode: 1, metadata: error.meta }),
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));

const {
  readAuthArtifactSource,
  refreshOpenKeySession,
  registerAuthCommand,
} = await import("./auth.js");

async function runAuthCommand(args: string[]): Promise<void> {
  await withTinyCloudStateRoot(testHome, async () => {
    await mkdir(profilePath(activeProfile), { recursive: true });
    const program = new Command().option("--host <url>");
    registerAuthCommand(program);
    await program.parseAsync(["node", "tc", ...args], { from: "node" });
  });
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
    // The callback state plus the authority fields verification set.
    expect(sessions.get("default")).toMatchObject({ ...openKeyDelegation, permissionsSource: "signed-recap" });
    expect(profiles.get("default")).toEqual(expect.objectContaining({
      did: "did:key:new-openkey",
      sessionDid: "did:key:new-openkey",
      authMethod: "openkey",
      posture: "owner-openkey",
      ownerDid: "did:pkh:eip155:1:0xowner",
      spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
    }));
    expect(recorded.outputs).toEqual([
      {
        rotated: true,
        profile: "default",
        oldDid: "did:key:old",
        did: "did:key:new-openkey",
        sessionDid: "did:key:new-openkey",
        authMethod: "openkey",
        spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
      },
    ]);
  });

  test("replica-enabled OpenKey rotation refuses legacy approval before replacing a live session or key", async () => {
    profiles.set("default", makeProfile({
      replication: { prefixes: ["applications/apps/"] },
    }));
    const originalKey = { kty: "OKP", crv: "Ed25519", x: "old", d: "private" };
    const originalSession = {
      permissions: [{
        service: "tinycloud.kv",
        space: "applications",
        path: "",
        actions: ["tinycloud.kv/get"],
      }],
    };
    keys.set("default", originalKey);
    sessions.set("default", originalSession);
    generatedKeys.push({
      jwk: { kty: "OKP", crv: "Ed25519", x: "new", d: "new-private" },
      did: "did:key:new-openkey",
    });

    await runAuthCommand(["auth", "rotate", "--paste"]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "V2_REQUIRED" })]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.setKeys).toEqual([]);
    expect(recorded.clearSessions).toEqual([]);
    expect(keys.get("default")).toEqual(originalKey);
    expect(sessions.get("default")).toEqual(originalSession);
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

    await runAuthCommand(["auth", "rotate"]);

    expect(recorded.errors).toEqual([]);
    expect(keys.get("default")).toBe(localSignInResult.jwk);
    expect(keys.get("default")).not.toBe(oldJwk);
    expect(recorded.clearSessions).toEqual([]);
    expect(recorded.localSignIns).toEqual([
      { privateKey: "0xowner-private", host: activeHost },
    ]);
    expect(sessions.get("default")).toEqual({
      authMethod: "local",
      address: "0xLocalOwner",
      ownerDid: "did:pkh:eip155:1:0xLocalOwner",
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

});

describe("CLI auth login command", () => {
  beforeEach(() => {
    resetState();
  });

  test.each([true, false])("replica-enabled OpenKey login never downgrades to v1 without a verified owner (key present: %s)", async (hasKey) => {
    profiles.set("default", makeProfile({
      did: "did:key:openkey-session",
      sessionDid: "did:key:openkey-session",
      authMethod: "openkey",
      replication: { prefixes: ["notes/"] },
    }));
    if (hasKey) keys.set("default", { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--no-popup"]);

    expect((recorded.errors[0] as CLIErrorLike)?.code).toBe("V2_REQUIRED");
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.setSessions).toEqual([]);
    expect(recorded.setKeys).toEqual([]);
    expect(recorded.generateKeyCalls).toBe(0);
  });

  test("browser login remains available when only stdout is redirected", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
    profiles.set("default", makeProfile({ did: "did:key:openkey-session", sessionDid: "did:key:openkey-session", authMethod: "openkey" }));
    keys.set("default", key);
    openKeyDelegation = { ...openKeyDelegation, verificationMethod: "did:key:openkey-session" };
    const oldStderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    try {
      await runAuthCommand(["auth", "login", "--method", "openkey"]);
      expect(recorded.errors).toEqual([]);
      expect(recorded.startAuthFlows).toEqual([
        { did: "did:key:openkey-session", options: expect.objectContaining({ jwk: key }) },
      ]);
    } finally {
      if (oldStderrTTY) Object.defineProperty(process.stderr, "isTTY", oldStderrTTY);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });

  test("device login without an explicit manifest is refused before any approval starts", async () => {
    profiles.set("default", makeProfile({ did: "did:key:openkey-session", authMethod: "openkey" }));
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" });

    await runAuthCommand(["auth", "login", "--device"]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "MANIFEST_REQUIRED" })]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(sessions.has("default")).toBe(false);
  });

  describe("OpenKey space setup after login (TC-1608)", () => {
    const unhosted = { ok: false, error: { code: "KV_NOT_FOUND", message: "404 - Space not found", meta: { status: 404 } } };

    function loginProfile(): void {
      profiles.set("default", makeProfile({ did: "did:key:openkey-session", sessionDid: "did:key:openkey-session", authMethod: "openkey" }));
      keys.set("default", { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" });
    }

    function nodeAnswering(answers: unknown[]): { reads: number; node: { kv: { get: () => Promise<unknown> } } } {
      const state = { reads: 0, node: { kv: { get: async () => answers[Math.min(state.reads++, answers.length - 1)] } } };
      return state;
    }

    test("waits while OpenKey is still hosting the space, then finishes the login", async () => {
      loginProfile();
      openKeyDelegation = { ...openKeyDelegation, verificationMethod: "did:key:openkey-session", spaceReady: null, spacePending: true };
      const node = nodeAnswering([unhosted, { ok: true, data: {} }]);
      restoredSessionNode = () => ({ node: node.node });
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);
        expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("Setting up your space");
      } finally {
        stderr.mockRestore();
      }

      expect(recorded.errors).toEqual([]);
      expect(node.reads).toBe(2);
      expect(recorded.outputs).toEqual([expect.objectContaining({ authenticated: true })]);
    }, 15_000);

    test("surfaces OpenKey's spaceError with its code and exits non-zero, keeping the saved session", async () => {
      loginProfile();
      const spaceError = "TinyCloud account setup failed (tinycloud_bootstrap_failed): seed failed.";
      openKeyDelegation = { ...openKeyDelegation, verificationMethod: "did:key:openkey-session", spaceReady: false, spaceError };
      restoredSessionNode = () => ({ node: nodeAnswering([unhosted]).node });

      await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);

      expect(recorded.errors).toEqual([expect.objectContaining({
        code: "SPACE_SETUP_FAILED",
        message: expect.stringContaining(spaceError),
      })]);
      expect(recorded.outputs).toEqual([]);
      expect(sessions.has("default")).toBe(true);
    });

    test.each([{}, { spaceReady: true }])("does not read from the node when OpenKey says the space is ready or says nothing (%j)", async (fields) => {
      loginProfile();
      let probes = 0;
      restoredSessionNode = () => { probes += 1; return { unavailable: "session_missing" }; };
      openKeyDelegation = { ...openKeyDelegation, verificationMethod: "did:key:openkey-session", ...fields };

      await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);

      expect(recorded.errors).toEqual([]);
      expect(probes).toBe(0);
    });
  });
});

describe("CLI auth commands on a missing profile (TC-682)", () => {
  beforeEach(() => {
    resetState();
    activeProfile = "owner";
  });

  test("logout refuses a profile that does not exist instead of reporting it logged out", async () => {
    await runAuthCommand(["auth", "logout"]);

    expect(recorded.outputs).toEqual([]);
    expect(recorded.clearSessions).toEqual([]);
    expect(recorded.errors).toEqual([expect.objectContaining({
      code: "PROFILE_NOT_FOUND",
    })]);
  });

  test("logout removes both restorable credentials of an existing profile", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
    profiles.set("owner", makeProfile({ name: "owner" }));
    keys.set("owner", key);
    sessions.set("owner", { delegationCid: "bafy-session" });

    await runAuthCommand(["auth", "logout"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.clearSessions).toEqual(["owner"]);
    expect(keys.has("owner")).toBe(false);
    expect(recorded.outputs).toEqual([{
      profile: "owner",
      authenticated: false,
      replicasRemoved: [],
      replicasKept: false,
      warning: expect.stringContaining("delegations and grants on the node stay valid until they expire"),
    }]);
  });
  test("logout --keep-replicas leaves replicas and reports the choice", async () => {
    profiles.set("owner", makeProfile({ name: "owner" }));

    await runAuthCommand(["auth", "logout", "--keep-replicas"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.clearSessions).toEqual(["owner"]);
    expect(recorded.removedReplicaProfiles).toEqual([]);
    expect(recorded.outputs).toEqual([expect.objectContaining({
      replicasRemoved: [],
      replicasKept: true,
    })]);
  });
  test("OpenKey login on a profile that does not exist creates a key-only profile, then runs the normal login", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "bootstrap-public", d: "bootstrap-private" };
    generatedKeys.push({ jwk: key, did: "did:key:new-openkey" });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);

    expect(recorded.errors).toEqual([]);
    // The first write is the key-only profile: a key and DID, no sign-in state.
    expect(recorded.setKeys[0]).toEqual({ profile: "owner", jwk: key });
    expect(recorded.setProfiles[0]?.data).toEqual({
      name: "owner",
      host: DEFAULT_HOST,
      chainId: 1,
      spaceName: "default",
      did: "did:key:new-openkey",
      createdAt: expect.any(String),
    });
    // The approval then starts for that key, and the verified result completes the login.
    expect(recorded.startAuthFlows).toEqual([expect.objectContaining({
      did: "did:key:new-openkey",
      options: expect.objectContaining({ jwk: key }),
    })]);
    expect(recorded.generateKeyCalls).toBe(1);
    expect(profiles.get("owner")).toEqual(expect.objectContaining({
      authMethod: "openkey",
      ownerDid: "did:pkh:eip155:1:0xowner",
    }));
    expect(sessions.get("owner")).toMatchObject({ delegationCid: "bafy-openkey-new" });
    expect(recorded.outputs).toContainEqual(expect.objectContaining({ authenticated: true, profile: "owner" }));
  });
  test("OpenKey login on a new profile saves an explicit --host on the key-only profile", async () => {
    generatedKeys.push({ jwk: { kty: "OKP", crv: "Ed25519", x: "p", d: "d" }, did: "did:key:new-openkey" });

    await runAuthCommand(["--host", "https://explicit.node.test", "auth", "login", "--method", "openkey", "--paste"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.setProfiles[0]?.data).toMatchObject({ name: "owner", host: "https://explicit.node.test" });
  });
  test("abandoning OpenKey login on a new profile leaves a key-only profile and grants nothing", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "bootstrap-public", d: "bootstrap-private" };
    generatedKeys.push({ jwk: key, did: "did:key:new-openkey" });
    startAuthFlowFailure = new Error("approval abandoned");

    await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);

    expect(recorded.errors).toEqual([startAuthFlowFailure]);
    expect(recorded.startAuthFlows).toHaveLength(1);
    expect(recorded.setSessions).toEqual([]);
    expect(sessions.has("owner")).toBe(false);
    expect(recorded.outputs).toEqual([]);
    expect(keys.get("owner")).toBe(key);
    const profile = profiles.get("owner")!;
    expect(profile).toEqual(expect.objectContaining({ name: "owner", did: "did:key:new-openkey" }));
    for (const field of ["authMethod", "posture", "ownerDid", "sessionDid", "spaceId"]) {
      expect(profile).not.toHaveProperty(field);
    }
  });
  test("local login bootstraps a profile that does not yet exist", async () => {
    await runAuthCommand(["auth", "login", "--method", "local"]);

    expect(recorded.errors).toEqual([]);
    expect(keys.get("owner")).toBe(localSignInResult.jwk);
    expect(profiles.get("owner")?.sessionDid).toBe(localSignInResult.verificationMethod);
    expect(profiles.get("owner")).toEqual(expect.objectContaining({
      name: "owner",
      authMethod: "local",
      posture: "local-owner-key",
    }));
    expect(recorded.outputs).toContainEqual(expect.objectContaining({ authenticated: true, profile: "owner" }));
  });

  test("OpenKey login with a missing key prepares a fresh session DID before approval", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "new-public", d: "new-private" };
    profiles.set("owner", makeProfile({ name: "owner", authMethod: "openkey" }));
    generatedKeys.push({ jwk: key, did: "did:key:new-openkey" });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.startAuthFlows).toEqual([expect.objectContaining({
      did: "did:key:new-openkey",
      options: expect.objectContaining({ jwk: key }),
    })]);
    expect(keys.get("owner")).toEqual(key);
    expect(profiles.get("owner")).toEqual(expect.objectContaining({
      did: "did:key:new-openkey",
      sessionDid: "did:key:new-openkey",
      ownerDid: "did:pkh:eip155:1:0xowner",
    }));
  });
  test("a rejected fresh-key OpenKey approval leaves the old profile without a stray key or session", async () => {
    const previous = makeProfile({ name: "owner", authMethod: "openkey" });
    profiles.set("owner", previous);
    generatedKeys.push({
      jwk: { kty: "OKP", crv: "Ed25519", x: "candidate-public", d: "candidate-private" },
      did: "did:key:candidate",
    });
    openKeyDelegation = { ...openKeyDelegation, delegationCid: "" };

    await runAuthCommand(["auth", "login", "--method", "openkey", "--paste"]);

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.startAuthFlows).toHaveLength(1);
    expect(keys.has("owner")).toBe(false);
    expect(sessions.has("owner")).toBe(false);
    expect(profiles.get("owner")).toEqual(previous);
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
    importRecorded.abandonedBootstraps.length = 0;
    ensureAuthenticatedError = null;
    bootstrapDelegatedSessionError = null;
    importSessionDid = "did:key:z6MkSession#z6MkSession";
    profiles.set("default", makeProfile({ posture: "owner-openkey" }));
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

  test("refuses a proofless cross-user portable grant without persistence or activation", async () => {
    // A transport audience for another key cannot substitute for signed proof.
    const delegation = makePortableDelegation({
      delegateDID: "did:pkh:eip155:1:0xAgent",
      cid: "bafy-cross-user",
    });
    const source = join(tempDir, "cross-user.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_AUTH_IMPORT", exitCode: 2 })]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(operationRecorded.calls).toEqual([]);
    expect(recorded.outputs).toEqual([]);
  });

  test("refuses a delegation whose header is not a single string Authorization before storing or activating it", async () => {
    for (const delegationHeader of [
      { authorization: "header.payload.signature" },
      { Authorization: ["header.payload.signature"] },
      { Authorization: "header.payload.signature", authorization: "other" },
    ]) {
      const source = join(tempDir, "mis-keyed.json");
      await writeFile(source, JSON.stringify({
        ...makePortableDelegation({ delegateDID: "did:key:z6MkSession", cid: "bafy-mis-keyed" }),
        delegationHeader,
      }), "utf8");

      await runAuthCommand(["auth", "import", source]);

      expect(recorded.errors.pop()).toMatchObject({ code: "INVALID_AUTH_IMPORT" });
    }
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
  });

  test("refuses a proofless session-targeted import before restore, bootstrap or persistence", async () => {
    const delegation = makePortableDelegation({
      delegateDID: "did:key:z6MkSession",
      cid: "bafy-proofless-session",
    });
    profiles.set("default", makeProfile({ sessionDid: "did:key:z6MkSession" }));
    keys.set("default", { did: "did:key:z6MkSession" });
    const source = join(tempDir, "proofless.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");
    ensureAuthenticatedError = new Error("restore must not run");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code: "INVALID_AUTH_IMPORT", exitCode: 2 });
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.grantHistory).toEqual([]);
  });

  test("does not persist a proofless delegation targeting the active session key", async () => {
    const delegation = makePortableDelegation({
      delegateDID: "did:key:z6MkSession",
      cid: "bafy-self-session",
    });
    const source = join(tempDir, "self-session.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code: "INVALID_AUTH_IMPORT", exitCode: 2 });
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.grantHistory).toEqual([]);
  });

  test("refuses a proofless first delegate grant before bootstrap", async () => {
    profiles.set("default", makeProfile({ posture: "delegate-session", sessionDid: "did:key:z6MkSession" }));
    keys.set("default", { did: "did:key:z6MkSession" });
    ensureAuthenticatedError = new Error("Not authenticated");
    const delegation = makePortableDelegation({
      delegateDID: "did:key:z6MkSession",
      cid: "bafy-first-delegation",
    });
    const source = join(tempDir, "first-delegation.json");
    await writeFile(source, JSON.stringify(delegation), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors.pop()).toMatchObject({ code: "INVALID_AUTH_IMPORT", exitCode: 2 });
    expect(importRecorded.bootstrappedDelegations).toEqual([]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
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

  test("bootstraps a fresh delegate profile before canonically importing its first request-bound delegation", async () => {
    const originalProfile = makeProfile({ posture: "delegate-session" });
    profiles.set("default", originalProfile);
    storedImportRequest = makeStoredImportRequest();
    operationRecorded.results.push({
      status: "ok",
      operation: { operationId: "tinycloud.auth.import", operationVersion: 1 },
      context: { profile: "default", host: activeHost, posture: "delegate-session" },
      output: {
        cid: "bafy-first-bound",
        effectivePermissions: storedImportRequest.requested,
        expiry: "2099-01-01T00:00:00.000Z",
        activated: true,
      },
    });
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_first_bound",
      delegation: makePortableDelegation({
        delegateDID: "did:key:z6MkSession",
        cid: "bafy-first-bound",
      }),
    };
    const source = join(tempDir, "first-bound.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([]);
    expect(importRecorded.bootstrappedDelegations).toEqual([{ cid: "bafy-first-bound" }]);
    expect(operationRecorded.calls).toEqual([{
      operationId: "tinycloud.auth.import",
      operationVersion: 1,
      target: { profile: "default", host: activeHost, allowOwnerProfile: true },
      input: artifact,
    }]);
    expect(recorded.clearSessions).toEqual([]);
    expect(recorded.setProfiles).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      requestId: "req_first_bound",
      delegationCid: "bafy-first-bound",
      activated: true,
    });
  });

  test("abandons a fresh delegate bootstrap when canonical request-bound validation rejects it", async () => {
    const originalProfile = makeProfile({ posture: "delegate-session" });
    profiles.set("default", originalProfile);
    operationRecorded.results.push({
      status: "error",
      error: {
        code: "DELEGATION_REJECTED",
        message: "The delegation exceeds the stored authority request.",
        retryable: false,
      },
    });
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_rejected_first",
      delegation: makePortableDelegation({
        delegateDID: "did:key:z6MkSession",
        cid: "bafy-rejected-first",
      }),
    };
    const source = join(tempDir, "rejected-first.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    const error = recorded.errors.pop();
    expect(error).toMatchObject({ code: "DELEGATION_REJECTED", exitCode: 1 });
    expect(importRecorded.bootstrappedDelegations).toEqual([{ cid: "bafy-rejected-first" }]);
    expect(importRecorded.abandonedBootstraps).toEqual([error]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
  });

  test("leaves rollback of a failed provisional bootstrap to the bootstrap itself", async () => {
    const originalProfile = makeProfile({ posture: "delegate-session" });
    profiles.set("default", originalProfile);
    bootstrapDelegatedSessionError = new Error("Invalid bootstrap delegation");
    const artifact = {
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_invalid_bootstrap",
      delegation: makePortableDelegation({
        delegateDID: "did:key:z6MkSession",
        cid: "bafy-invalid-bootstrap",
      }),
    };
    const source = join(tempDir, "invalid-bootstrap.json");
    await writeFile(source, JSON.stringify(artifact), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([bootstrapDelegatedSessionError]);
    expect(operationRecorded.calls).toEqual([]);
    expect(importRecorded.abandonedBootstraps).toEqual([]);
    expect(recorded.clearSessions).toEqual([]);
    expect(recorded.setProfiles).toEqual([]);
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

  test("refuses an unbound proofless v1 envelope before persistence", async () => {
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

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_AUTH_IMPORT", exitCode: 2 })]);
    expect(operationRecorded.calls).toEqual([]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.outputs).toEqual([]);
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

  test("refuses a proofless cross-user stored wrapper despite its display permissions", async () => {
    const source = join(tempDir, "stored-wrapper.json");
    await writeFile(source, JSON.stringify({
      delegation: makePortableDelegation({ delegateDID: "did:pkh:eip155:1:0xAgent", cid: "bafy-stored-wrapper" }),
      permissions: [{
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0xOwner:secrets",
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
      }],
    }), "utf8");

    await runAuthCommand(["auth", "import", source]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_AUTH_IMPORT", exitCode: 2 })]);
    expect(importRecorded.appendedDelegations).toEqual([]);
    expect(importRecorded.useRuntimeDelegation).toEqual([]);
    expect(recorded.outputs).toEqual([]);
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
    expect(recorded.localGrantArtifacts).toEqual([{
      profile: "default",
      delegation: grantedDelegation,
    }]);
    expect(recorded.grantHistory).toContainEqual({
      profile: "default",
      entry: {
        addedCaps: request.requested,
        source: "cli",
        delegationCid: "bafy-granted-request",
        expiry: "2099-01-01T00:00:00.000Z",
      },
    });
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
    // The signer receives the one resolved list (space ids, not names) that was printed and gated.
    expect(recorded.grantedRequests).toEqual([{
      ...request,
      requested: [{ ...request.requested[0], space: "tinycloud:pkh:eip155:1:0xOwner:secrets" }],
    }]);
  });

  test.each([
    ["a hostile sessionDid", { sessionDid: "did:key:z6Mk\u001b[2J\u202e" }],
    ["a hostile requestedExpiry", { requestedExpiry: "7d\u001b[2J\u202e" }],
  ])("%s is refused before anything is printed or signed", async (_name, override) => {
    profiles.set("default", makeProfile());
    const request = {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_hostile_fields",
      sessionDid: "did:key:z6MkSession",
      // a request that WOULD print a scope text and ask for confirmation if it got that far
      requested: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/del"] }],
      ...override,
    };
    const source = join(tempDir, "hostile-fields.json");
    await writeFile(source, JSON.stringify(request), "utf8");
    const streams: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      streams.push(`stderr:${String(chunk)}`);
      return true;
    }) as never);
    const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      streams.push(`stdout:${String(chunk)}`);
      return true;
    }) as never);
    try {
      await runAuthCommand(["auth", "grant", source, "--yes"]);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toMatchObject({ code: "INVALID_AUTH_REQUEST", exitCode: 2 });
    expect(recorded.grantedRequests).toEqual([]);
    // no scope text, no notice, nothing at all was written before the refusal
    expect(streams).toEqual([]);
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

describe("CLI auth request command", () => {
  beforeEach(() => {
    resetState();
  });

  test("a grant spanning two spaces says up front that OpenKey needs two approvals, and numbers each prompt", async () => {
    profiles.set("default", makeProfile({
      did: "did:key:openkey-session",
      sessionDid: "did:key:openkey-session",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    sessions.set("default", { authMethod: "openkey", spaceId: "tinycloud:pkh:eip155:1:0xowner:default" });
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "k", d: "private" });
    authNodeHasRuntimePermissions = false;
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await runAuthCommand([
        "auth", "request", "--grant", "--paste",
        "--cap", "tinycloud.kv:account:applications/:get",
        "--cap", "tinycloud.space:default::list",
      ]);
    } finally {
      stderr.mockRestore();
    }

    // The mocked OpenKey reply carries no verifiable proof, so the grant stops after the first approval;
    // the notices precede that prompt (the full numbering is unit-tested in approval-notices.test.ts).
    const lines = written.join("").split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "This needs 2 approvals in OpenKey (account space, then default space).",
      "Approval 1 of 2: account space...",
    ]);
    expect(recorded.startAuthFlows).toHaveLength(1);
  });

  test("a single-space grant prints no approval counts", async () => {
    profiles.set("default", makeProfile({
      did: "did:key:openkey-session",
      sessionDid: "did:key:openkey-session",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    sessions.set("default", { authMethod: "openkey", spaceId: "tinycloud:pkh:eip155:1:0xowner:default" });
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "k", d: "private" });
    authNodeHasRuntimePermissions = false;
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await runAuthCommand(["auth", "request", "--grant", "--paste", "--cap", "tinycloud.kv:default/:list"]);
    } finally {
      stderr.mockRestore();
    }
    expect(written.join("")).not.toContain("approval");
  });

  test("--paste reaches the OpenKey flow for an owner grant, and is refused anywhere it cannot apply", async () => {
    profiles.set("default", makeProfile({
      did: "did:key:openkey-session",
      sessionDid: "did:key:openkey-session",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    sessions.set("default", { authMethod: "openkey", spaceId: "tinycloud:pkh:eip155:1:0xowner:default" });
    keys.set("default", { kty: "OKP", crv: "Ed25519", x: "k", d: "private" });
    authNodeHasRuntimePermissions = false;

    await runAuthCommand(["auth", "request", "--grant", "--paste", "--cap", "tinycloud.kv:default/:list"]);
    expect(recorded.startAuthFlows).toHaveLength(1);
    expect(recorded.startAuthFlows[0]?.options.paste).toBe(true);

    recorded.startAuthFlows.length = 0;
    recorded.errors.length = 0;
    await runAuthCommand(["auth", "request", "--paste", "--cap", "tinycloud.kv:default/:list"]);
    await runAuthCommand(["auth", "request", "--grant", "--paste", "--device", "--cap", "tinycloud.kv:default/:list"]);
    // A local-key owner has no OpenKey flow to paste into.
    profiles.set("default", makeProfile({
      did: "did:pkh:eip155:1:0xLocalOwner",
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0xowner-private",
      address: "0xLocalOwner",
    }));
    await runAuthCommand(["auth", "request", "--grant", "--paste", "--cap", "tinycloud.kv:default/:list"]);
    expect(recorded.startAuthFlows).toEqual([]);
    expect(recorded.errors).toEqual([
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    ]);
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
      ownerDid: "did:pkh:eip155:1:0xLocalOwner",
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

  test("does not restore a local session after a concurrent durable sign-out", async () => {
    profiles.set("default", makeProfile({
      did: "did:pkh:eip155:1:0xLocalOwner",
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0xowner-private",
      address: "0xLocalOwner",
    }));
    sessions.set("default", { delegationCid: "bafy-old-session", spaceId: "space-local-old" });
    authNodeHasRuntimePermissions = false;
    authNodeGrantDelegations = [{ cid: "bafy-new-grant", expiry: new Date("2099-01-01T00:00:00.000Z") }];
    authNodeRestorableSession = {
      address: "0xLocalOwner",
      chainId: 1,
      spaceId: "space-local-new",
      delegationHeader: { Authorization: "Bearer runtime-session" },
      delegationCid: "bafy-runtime-session",
      jwk: { kty: "OKP", crv: "Ed25519", x: "new-session", d: "private" },
      verificationMethod: "did:key:new-session",
      siwe: "runtime-siwe",
      signature: "0xruntime",
    };
    onGrantRuntimePermissions = () => {
      profiles.set("default", { ...profiles.get("default")!, authSignedOut: true });
      sessions.delete("default");
      keys.delete("default");
    };

    await runAuthCommand(["auth", "request", "--grant", "--yes", "--cap", "tinycloud.kv:default/:list"]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "PROFILE_CHANGED_DURING_LOGIN" })]);
    expect(sessions.has("default")).toBe(false);
    expect(keys.has("default")).toBe(false);
    expect(profiles.get("default")?.authSignedOut).toBe(true);
    expect(recorded.outputs).toEqual([]);
  });

  test("does not save a local grant session after a logout marker is committed", async () => {
    profiles.set("default", makeProfile({
      did: "did:pkh:eip155:1:0xLocalOwner",
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0xowner-private",
      address: "0xLocalOwner",
    }));
    const priorSession = { delegationCid: "bafy-old-session", spaceId: "space-local-old" };
    sessions.set("default", priorSession);
    authNodeHasRuntimePermissions = false;
    authNodeGrantDelegations = [{ cid: "bafy-new-grant", expiry: new Date("2099-01-01T00:00:00.000Z") }];
    authNodeRestorableSession = {
      address: "0xLocalOwner",
      chainId: 1,
      spaceId: "space-local-new",
      delegationHeader: { Authorization: "Bearer runtime-session" },
      delegationCid: "bafy-runtime-session",
      jwk: { kty: "OKP", crv: "Ed25519", x: "new-session", d: "private" },
      verificationMethod: "did:key:new-session",
      siwe: "runtime-siwe",
      signature: "0xruntime",
    };
    let markerPath: string | undefined;
    onGrantRuntimePermissions = async () => {
      markerPath = join(profilePath("default"), REPLICA_LOGOUT_PENDING_FILE);
      await writeFile(markerPath, "{}");
    };

    try {
      await runAuthCommand(["auth", "request", "--grant", "--yes", "--cap", "tinycloud.kv:default/:list"]);
      expect(recorded.errors).toEqual([expect.objectContaining({ code: "PROFILE_CHANGED_DURING_LOGIN" })]);
      expect(sessions.get("default")).toEqual(priorSession);
      expect(recorded.setSessions).toEqual([]);
      expect(recorded.outputs).toEqual([]);
    } finally {
      if (markerPath) await rm(markerPath, { force: true });
    }
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
      sessionDid: "did:key:z6MkSession",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    keys.set("default", fullKey);
    openKeyDelegation = {
      delegationHeader: { Authorization: "Bearer openkey-new" },
      delegationCid: "bafy-openkey",
      spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
      ownerDid: "did:pkh:eip155:1:0xowner",
      verificationMethod: "did:key:z6MkSession",
      expiry: "2099-01-01T00:00:00.000Z",
      siwe: "siwe-message",
      signature: "0xsignature",
      address: "0xowner",
      chainId: 1,
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

  test("a `d` in OpenKey's JWK is ignored: session.json signs with key.json's key (TC-1053)", async () => {
    const fullKey = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
    profiles.set("default", makeProfile({
      did: "did:key:z6MkSession",
      sessionDid: "did:key:z6MkSession",
      authMethod: "openkey",
      posture: "owner-openkey",
    }));
    keys.set("default", fullKey);
    openKeyDelegation = {
      delegationHeader: { Authorization: "Bearer openkey-new" },
      delegationCid: "bafy-openkey",
      spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
      ownerDid: "did:pkh:eip155:1:0xowner",
      verificationMethod: "did:key:z6MkSession",
      expiry: "2099-01-01T00:00:00.000Z",
      siwe: "siwe-message",
      signature: "0xsignature",
      address: "0xowner",
      chainId: 1,
      jwk: { kty: "OKP", crv: "Ed25519", x: "key-public", d: "openkey-returned-private" },
    };

    await refreshOpenKeySession("default", activeHost);

    const persisted = sessions.get("default") as { jwk: { d?: string } };
    expect(persisted.jwk).toEqual(fullKey);
  });
});

describe("OpenKey primary key (TC-705)", () => {
  const sessionDid = "did:key:openkey-session";
  const key = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
  const primaryOwner = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
  const otherOwner = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
  let stderr: string[];
  let restoreStderr: () => void;

  function signedBy(owner: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...openKeyDelegation,
      verificationMethod: sessionDid,
      address: owner.split(":")[4],
      chainId: 1,
      spaceId: `tinycloud:${owner.slice("did:".length)}:default`,
      ...extra,
    };
  }

  beforeEach(() => {
    resetState();
    profiles.set("default", makeProfile({ did: sessionDid, sessionDid, authMethod: "openkey", posture: "owner-openkey" }));
    keys.set("default", key);
    stderr = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => { process.stderr.write = original; };
  });

  afterEach(() => restoreStderr());

  test("a first login approved by the primary key records it and names the new owner, with no primary-key warning", async () => {
    openKeyDelegation = signedBy(primaryOwner, { primary: true });

    const { profile } = await refreshOpenKeySession("default", activeHost);

    expect(profile.ownerDid).toBe(primaryOwner);
    expect(profile.ownerKeyPrimary).toBe(true);
    expect(profiles.get("default")?.ownerKeyPrimary).toBe(true);
    // No primary-key warning; the first login names the owner it pinned (TC-1058).
    expect(stderr.join("")).not.toContain("primary OpenKey key");
    expect(stderr.join("")).toContain(primaryOwner);
  });

  test("a login approved by another key succeeds, records it and warns on stderr only", async () => {
    openKeyDelegation = signedBy(otherOwner, { primary: false });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--no-popup"]);

    expect(recorded.errors).toEqual([]);
    expect(profiles.get("default")?.ownerKeyPrimary).toBe(false);
    expect(sessions.has("default")).toBe(true);
    const warning = stderr.join("");
    expect(warning).toContain("0x00000000000000000000000000000000000000bb");
    expect(warning).toContain("not your account's primary OpenKey key");
    expect(warning).toContain("separate owner with its own spaces and data");
    // Machine output carries no warning text.
    expect(JSON.stringify(recorded.outputs)).not.toContain("primary OpenKey key");
  });

  test("a proof whose space belongs to another account is refused and saves nothing (TC-1053)", async () => {
    openKeyDelegation = signedBy(otherOwner, { spaceId: `tinycloud:${primaryOwner.slice("did:".length)}:default` });

    await expect(refreshOpenKeySession("default", activeHost)).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });

    expect(sessions.has("default")).toBe(false);
    expect(profiles.get("default")?.ownerDid).toBeUndefined();
  });

  test("an OpenKey that does not report the flag records nothing, clears an earlier answer and stays quiet", async () => {
    profiles.set("default", makeProfile({ did: sessionDid, sessionDid, authMethod: "openkey", posture: "owner-openkey", ownerKeyPrimary: false }));
    openKeyDelegation = signedBy(primaryOwner);

    const { profile } = await refreshOpenKeySession("default", activeHost);

    expect("ownerKeyPrimary" in profile).toBe(false);
    expect(profiles.get("default")?.ownerKeyPrimary).toBeUndefined();
    expect(stderr.join("")).not.toContain("primary OpenKey key");
  });

  test("a login on a profile that already has an owner names no new owner (TC-1058)", async () => {
    profiles.set("default", makeProfile({ did: sessionDid, sessionDid, authMethod: "openkey", posture: "owner-openkey", ownerDid: primaryOwner }));
    openKeyDelegation = signedBy(primaryOwner, { primary: true });

    await refreshOpenKeySession("default", activeHost);

    expect(stderr.join("")).toBe("");
  });

  test("a first login with --owner names no new owner: the operator chose it (TC-1058)", async () => {
    openKeyDelegation = signedBy(otherOwner, { primary: true });

    await refreshOpenKeySession("default", activeHost, { expectedOwner: otherOwner });

    expect(profiles.get("default")?.ownerDid).toBe(otherOwner);
    expect(stderr.join("")).toBe("");
  });

  test("a login without a proof is refused, saving neither the flag nor a session (TC-1053)", async () => {
    const { siwe: _siwe, signature: _signature, ...unsigned } = signedBy(otherOwner, { primary: false });
    openKeyDelegation = unsigned;

    await expect(refreshOpenKeySession("default", activeHost)).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });

    expect(profiles.get("default")?.ownerKeyPrimary).toBeUndefined();
    expect(sessions.has("default")).toBe(false);
  });

  test("--owner on a plain login names that owner's space so OpenKey preselects its key", async () => {
    openKeyDelegation = signedBy(otherOwner, { primary: false });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--no-popup", "--owner", otherOwner]);

    expect(recorded.errors).toEqual([]);
    const requested = recorded.startAuthFlows[0]?.options.permissions as Array<{ service: string; space: string; actions: string[] }>;
    const space = `tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000bb:default`;
    expect(requested.map((entry) => [entry.service, entry.space])).toEqual([
      ["tinycloud.kv", space],
      ["tinycloud.sql", space],
      ["tinycloud.capabilities", space],
      ["tinycloud.delegation", space],
    ]);
    expect(profiles.get("default")?.ownerDid).toBe(otherOwner);
    expect(profiles.get("default")?.ownerKeyPrimary).toBe(false);
  });

  test("a profile pinned to an owner sends that owner's space without --owner so OpenKey preselects its key (TC-1327)", async () => {
    profiles.set("default", makeProfile({ did: sessionDid, sessionDid, authMethod: "openkey", posture: "owner-openkey", ownerDid: otherOwner }));
    openKeyDelegation = signedBy(otherOwner, { primary: false });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--no-popup"]);

    expect(recorded.errors).toEqual([]);
    const requested = recorded.startAuthFlows[0]?.options.permissions as Array<{ service: string; space: string }>;
    const space = `tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000bb:default`;
    expect(requested?.map((entry) => [entry.service, entry.space])).toEqual([
      ["tinycloud.kv", space],
      ["tinycloud.sql", space],
      ["tinycloud.capabilities", space],
      ["tinycloud.delegation", space],
    ]);
  });

  test("--owner refuses an approval by any other key and saves nothing", async () => {
    openKeyDelegation = signedBy(primaryOwner, { primary: true });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--no-popup", "--owner", otherOwner]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "OPENKEY_OWNER_MISMATCH" })]);
    expect(sessions.has("default")).toBe(false);
    expect(profiles.get("default")?.ownerDid).toBeUndefined();
  });

  test("a plain login without --owner requests the default abilities plus delegation/list on the default space", async () => {
    openKeyDelegation = signedBy(primaryOwner, { primary: true });

    await runAuthCommand(["auth", "login", "--method", "openkey", "--no-popup"]);

    const requested = recorded.startAuthFlows[0]?.options.permissions as Array<{ service: string; space: string; actions: string[] }>;
    expect(requested.map((entry) => [entry.service, entry.space])).toEqual([
      ["tinycloud.kv", "default"],
      ["tinycloud.sql", "default"],
      ["tinycloud.capabilities", "default"],
      ["tinycloud.delegation", "default"],
    ]);
    expect(requested.find((entry) => entry.service === "tinycloud.delegation")?.actions).toEqual(["tinycloud.delegation/list"]);
  });

  test("auth status reports whether the owner key is primary", async () => {
    profiles.set("default", makeProfile({ did: sessionDid, sessionDid, ownerDid: otherOwner, ownerKeyPrimary: false }));

    await runAuthCommand(["auth", "status"]);

    expect(recorded.outputs).toEqual([expect.objectContaining({ ownerDid: otherOwner, ownerKeyPrimary: false })]);
  });

  test("auth status reports null when OpenKey never said", async () => {
    profiles.set("default", makeProfile({ did: sessionDid, sessionDid, ownerDid: primaryOwner }));

    await runAuthCommand(["auth", "status"]);

    expect(recorded.outputs).toEqual([expect.objectContaining({ ownerKeyPrimary: null })]);
  });
});

function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, isTTY: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { configurable: true, value: isTTY });
  return () => {
    if (original) Object.defineProperty(stream, "isTTY", original);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

describe("auth grant for an OpenKey owner gets a fresh owner approval per agent request (TC-1422)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sessionDid = "did:key:z6MktdN3L74zrn1iFLmaRviQ4HEaC8gTcM8xND9BYfZ4Ep51#z6MktdN3L74zrn1iFLmaRviQ4HEaC8gTcM8xND9BYfZ4Ep51";
  const primaryOwner = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
  const otherOwner = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
  const key = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
  let tempDir: string;
  const restores: Array<Record<string, unknown>> = [];
  let restoreSpy: { mockRestore(): void } | undefined;

  function approvalBy(owner: string, validForMs: number): Record<string, unknown> {
    return {
      ...openKeyDelegation,
      verificationMethod: sessionDid,
      address: owner.split(":")[4],
      chainId: 1,
      spaceId: `tinycloud:${owner.slice("did:".length)}:secrets`,
      verifiedPath: "vault/secrets/ANTHROPIC_API_KEY",
      expiry: new Date(Date.now() + validForMs).toISOString(),
    };
  }

  beforeEach(async () => {
    resetState();
    tempDir = await mkdtemp(join(tmpdir(), "tc-auth-grant-openkey-"));
    profiles.set("default", makeProfile({
      did: sessionDid,
      sessionDid,
      authMethod: "openkey",
      posture: "owner-openkey",
      ownerDid: primaryOwner,
    }));
    keys.set("default", key);
    sessions.set("default", { authMethod: "openkey", spaceId: "tinycloud:pkh:eip155:1:0xowner:default" });
    restores.length = 0;
    restoreSpy = spyOn(TinyCloudNode.prototype, "restoreSession").mockImplementation(async (sessionData: object) => {
      restores.push(sessionData as Record<string, unknown>);
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    restoreSpy?.mockRestore();
  });

  async function writeAgentRequest(name: string, requestedExpiry?: string): Promise<string> {
    const source = join(tempDir, name);
    await writeFile(source, JSON.stringify(makeStoredImportRequest({
      posture: "delegate-session",
      operatorType: "agent",
      sessionDid,
      requested: [{
        service: "tinycloud.kv",
        space: `tinycloud:${primaryOwner.slice("did:".length)}:secrets`,
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
      }],
      ...(requestedExpiry === undefined ? {} : { requestedExpiry }),
    })), "utf8");
    return source;
  }

  test("an agent request gets the owner's approval even when runtime authority already covers it", async () => {
    authNodeHasRuntimePermissions = true;
    openKeyDelegation = approvalBy(primaryOwner, 2 * DAY_MS);
    const source = await writeAgentRequest("openkey-agent-covered.json");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.startAuthFlows.map((flow) => flow.did)).toEqual([sessionDid]);
    expect(recorded.grantedRequests).toHaveLength(1);
    expect(restores.map((sessionData) => sessionData.spaceId)).toEqual([openKeyDelegation.spaceId]);
  });

  test("the grant lasts as long as the owner's approval, not the requested lifetime", async () => {
    openKeyDelegation = approvalBy(primaryOwner, 2 * DAY_MS);
    const source = await writeAgentRequest("openkey-agent-lifetime.json", "7d");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    const [grantExpiry] = recorded.grantedExpiries;
    expect(grantExpiry).toBeLessThanOrEqual(2 * DAY_MS);
    expect(grantExpiry).toBeGreaterThan(2 * DAY_MS - 60_000);
  });

  test("the approval requested from OpenKey for an agent is capped at 7 days", async () => {
    openKeyDelegation = approvalBy(primaryOwner, 2 * DAY_MS);
    const source = await writeAgentRequest("openkey-agent-capped.json", "30d");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    expect(recorded.startAuthFlows[0]?.options.expiry).toBe("604800s");
  });

  test("an approval from another owner is refused and no grant is stored", async () => {
    openKeyDelegation = approvalBy(otherOwner, 2 * DAY_MS);
    const source = await writeAgentRequest("openkey-agent-refused.json");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "OPENKEY_OWNER_MISMATCH" })]);
    expect(recorded.grantedRequests).toEqual([]);
    expect(recorded.localGrantArtifacts).toEqual([]);
  });

  test("with no terminal attached the OpenKey approval is printed for a URL, not opened in a browser", async () => {
    openKeyDelegation = approvalBy(primaryOwner, 2 * DAY_MS);
    const source = await writeAgentRequest("openkey-agent-headless.json");
    const restore = [setTTY(process.stdin, false), setTTY(process.stderr, false)];
    try {
      await runAuthCommand(["auth", "grant", source, "--yes"]);
    } finally {
      for (const undo of restore) undo();
    }

    expect(recorded.startAuthFlows[0]?.options.noPopup).toBe(true);
  });

  test("with a terminal attached the OpenKey approval opens in the browser", async () => {
    openKeyDelegation = approvalBy(primaryOwner, 2 * DAY_MS);
    const source = await writeAgentRequest("openkey-agent-interactive.json");
    const restore = [setTTY(process.stdin, true), setTTY(process.stderr, true)];
    try {
      await runAuthCommand(["auth", "grant", source, "--yes"]);
    } finally {
      for (const undo of restore) undo();
    }

    expect(recorded.startAuthFlows[0]?.options.noPopup).toBe(false);
  });

  test("an agent request whose owner approval unchecks an ability is refused and stores nothing", async () => {
    openKeyDelegation = { ...approvalBy(primaryOwner, 2 * DAY_MS), kvUnchecked: true };
    const source = await writeAgentRequest("openkey-agent-narrow.json");

    await runAuthCommand(["auth", "grant", source, "--yes"]);

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "OPENKEY_APPROVAL_NARROWER" })]);
    expect(recorded.grantedRequests).toEqual([]);
    expect(recorded.localGrantArtifacts).toEqual([]);
  });
});

describe("auth grant asks the owner about entries beyond the preset on the terminal, wherever stdout goes", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetState();
    profiles.set("default", makeProfile());
    tempDir = await mkdtemp(join(tmpdir(), "tc-auth-grant-confirm-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A request with one entry the apps-agent preset never grants (delete), so it is marked `!`. */
  async function writeBeyondPresetRequest(): Promise<string> {
    const source = join(tempDir, "beyond-preset.json");
    await writeFile(source, JSON.stringify({
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_beyond_preset",
      sessionDid: "did:key:z6MkSession",
      requested: [{ service: "tinycloud.kv", space: "applications", path: "xyz.example.app/", actions: ["tinycloud.kv/del"] }],
    }), "utf8");
    return source;
  }

  /**
   * Runs `auth grant` with each stream's terminal state set as given, `answer` (if any) waiting on
   * stdin, and stdout/stderr captured. Returns what was written to stderr and whether anything
   * started reading stdin.
   */
  async function grantWith(
    args: string[],
    terminal: { stdin: boolean; stdout: boolean; stderr: boolean },
    answer?: string,
  ): Promise<{ stderr: string; stdinRead: boolean }> {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const input = Object.assign(Readable.from(answer === undefined ? [] : [answer]), { setRawMode: () => input });
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    const restore = [
      setTTY(process.stdin, terminal.stdin),
      setTTY(process.stdout, terminal.stdout),
      setTTY(process.stderr, terminal.stderr),
    ];
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await runAuthCommand(["auth", "grant", ...args]);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      for (const undo of restore) undo();
      if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
    }
    return { stderr: stderr.join(""), stdinRead: input.readableFlowing !== null };
  }

  test("stdout redirected to a file still gets the question on the terminal, and a yes signs", async () => {
    const source = await writeBeyondPresetRequest();

    const { stderr, stdinRead } = await grantWith([source], { stdin: true, stdout: false, stderr: true }, "y\n");

    expect(stdinRead).toBe(true);
    expect(stderr).toContain("1 entry marked !");
    expect(recorded.errors).toEqual([]);
    expect(recorded.grantedRequests).toHaveLength(1);
  });

  test("with stdout redirected, any answer but yes cancels and signs nothing", async () => {
    const source = await writeBeyondPresetRequest();

    await grantWith([source], { stdin: true, stdout: false, stderr: true }, "n\n");

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "REQUEST_CANCELLED" })]);
    expect(recorded.grantedRequests).toEqual([]);
  });

  test.each([
    ["no terminal at all", { stdin: false, stdout: false, stderr: false }],
    ["piped stdin, even with stdout and stderr on a terminal", { stdin: false, stdout: true, stderr: true }],
    ["stderr redirected, so the question would not be seen", { stdin: true, stdout: true, stderr: false }],
  ])("%s: refused with CONFIRMATION_REQUIRED, nothing read from stdin, nothing signed", async (_name, terminal) => {
    const source = await writeBeyondPresetRequest();

    const { stderr, stdinRead } = await grantWith([source], terminal, "y\n");

    expect(recorded.errors).toEqual([expect.objectContaining({ code: "CONFIRMATION_REQUIRED", exitCode: 2 })]);
    expect(stdinRead).toBe(false);
    expect(stderr).not.toContain("1 entry marked !");
    expect(recorded.grantedRequests).toEqual([]);
  });

  test("--yes signs without a terminal and without asking", async () => {
    const source = await writeBeyondPresetRequest();

    const { stderr } = await grantWith([source, "--yes"], { stdin: false, stdout: false, stderr: false });

    expect(stderr).not.toContain("1 entry marked !");
    expect(recorded.errors).toEqual([]);
    expect(recorded.grantedRequests).toHaveLength(1);
  });
});
