import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

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
      jwk?: object;
      host?: string;
      openkeyHost?: string;
      permissions?: unknown[];
      expiry?: string | number;
    };
  }>,
  localSignIns: [] as Array<{ privateKey: string; host: string }>,
  spinners: [] as string[],
  generateKeyCalls: 0,
};

let activeProfile = "default";
let activeHost = "https://node.tinycloud.test";
let profiles = new Map<string, ProfileLike>();
let keys = new Map<string, object>();
let sessions = new Map<string, object>();
let generatedKeys: GeneratedKey[] = [];
let openKeyDelegation: Record<string, unknown>;
let localSignInResult: LocalSignInResult;

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

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => ({
    hasRuntimePermissions: () => true,
    getRuntimePermissionDelegations: () => [],
  }),
}));

mock.module("../lib/permissions.js", () => ({
  appendAdditionalDelegation: async () => {},
  appendPermissionRequestArtifact: async () => {},
  createPermissionRequestArtifact: () => ({}),
  getLastPermissionRequestArtifact: async () => null,
  getPermissionRequestArtifact: async () => null,
  isDelegationImportArtifact: () => false,
  isPermissionRequestArtifact: () => false,
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

const { ensureDelegationAuthority, registerAuthCommand } = await import("./auth.js");

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
