import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const TEST_HOME = await mkdtemp(join(tmpdir(), "tc-secrets-owner-retry-"));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

const SECRET_VALUE_CANARY = "tc-191-owner-secret-value-canary";
const NETWORK_ID = "urn:tinycloud:encryption:did:key:z6MkOwner:default";

const profile = {
  name: "default",
  host: "https://node.tinycloud.test",
  chainId: 1,
  spaceName: "default",
  did: "did:pkh:eip155:1:0xOwner",
  createdAt: "2026-07-14T12:00:00.000Z",
  authMethod: "openkey" as const,
  posture: "owner-openkey" as const,
  operatorType: "human" as const,
};

const secretAttempts: string[] = [];
let operationAttempts = 0;
const installedDelegations: string[] = [];
let currentSession: Record<string, unknown> | null = { expiresAt: "2099-01-01T00:00:00.000Z" };

const node = {
  did: "did:key:z6MkOwner",
  hasRuntimePermissions: () => false,
  getDefaultEncryptionNetworkId: () => NETWORK_ID,
  getEncryptionNetworkIdForSpace: () => NETWORK_ID,
  useRuntimeDelegation: async (delegation: { cid: string }) => {
    installedDelegations.push(delegation.cid);
  },
  secrets: {
    get: async (name: string) => {
      secretAttempts.push(name);
      if (secretAttempts.length === 1) {
        return {
          ok: false as const,
          error: {
            code: "PERMISSION_DENIED",
            message: "missing capability for secrets get",
          },
        };
      }
      if (secretAttempts.length === 2) {
        return { ok: true as const, data: SECRET_VALUE_CANARY };
      }
      throw new Error("secrets get retried more than once");
    },
  },
};

mock.module("@tinycloud/node-sdk", () => ({
  TinyCloudNode: class TinyCloudNode {},
  NodeWasmBindings: class NodeWasmBindings {
    parseRecapFromSiwe(): unknown[] {
      return [];
    }
  },
  grantAuthRequest: async () => ({}),
  canonicalizeAddress: (address: string) => address.toLowerCase(),
  makePkhSpaceId: (address: string, chainId: number, name: string) =>
    `tinycloud:pkh:eip155:${chainId}:${address.toLowerCase()}:${name}`,
  parsePkhDid: () => null,
  parseSpaceUri: () => null,
  activateValidatedRuntimeDelegation: async () => ({
    cid: "bafy-owner-openkey",
    effectivePermissions: [],
    delegation: {},
    expiry: new Date("2099-01-01T00:00:00.000Z"),
    audience: "did:key:z6MkOwner",
    host: profile.host,
  }),
  principalDidEquals: (a: string, b: string) => a === b,
}));

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "default", host: profile.host }),
    getProfile: async () => profile,
    getSession: async () => currentSession,
    setSession: async (_profile: string, session: Record<string, unknown>) => {
      currentSession = session;
    },
    setProfile: async () => undefined,
    getKey: async () => ({
      kty: "OKP",
      crv: "Ed25519",
      x: "owner",
      d: "private",
    }),
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => node,
  bootstrapDelegatedSession: async () => node,
}));

mock.module("@tinycloud/operations", () => ({
  invokeOperation: async (
    operationId: string,
    operationVersion: number,
  ) => {
    expect(operationId).toBe("tinycloud.secrets.get");
    expect(operationVersion).toBe(1);
    if (operationAttempts === 0) {
      operationAttempts += 1;
      return {
        status: "authority_required" as const,
        operation: { operationId, operationVersion },
        context: { profile: "default", host: profile.host, posture: "owner-openkey" as const },
        missing: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/ANTHROPIC_API_KEY",
            actions: ["tinycloud.kv/get"],
          },
          {
            service: "tinycloud.encryption",
            path: NETWORK_ID,
            actions: ["tinycloud.encryption/decrypt"],
          },
        ],
        request: { requestId: "request-owner" },
        approval: { kind: "openkey" as const, requestId: "request-owner", fallback: "tc auth grant" },
        retry: { operationId, operationVersion, inputDigest: "digest", requiresCallerInput: false },
      };
    }
    if (operationAttempts === 1) {
      operationAttempts += 1;
      return {
        status: "ok" as const,
        operation: { operationId, operationVersion },
        context: { profile: "default", host: profile.host, posture: "owner-openkey" as const },
        output: { value: SECRET_VALUE_CANARY },
      };
    }
    throw new Error("operation retried more than once");
  },
}));

mock.module("../auth/local-key.js", () => ({
  generateLocalIdentity: async () => ({}),
  deriveAddress: async () => "0xOwner",
  addressToDID: () => profile.did,
  localKeySignIn: async () => ({}),
  generateKey: () => ({}),
  keyToDID: () => profile.did,
}));

const { registerSecretsCommand } = await import("./secrets.js");

afterAll(async () => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("owner secrets get OpenKey retry", () => {
  test("acquires once and retries the secret exactly once through the real owner path", async () => {
    secretAttempts.length = 0;
    operationAttempts = 0;
    installedDelegations.length = 0;
    let acquisitions = 0;
    let stdout = "";
    const output = process.stdout as unknown as {
      write: (chunk: unknown) => boolean;
    };
    const originalWrite = output.write;
    output.write = (chunk: unknown) => {
      stdout += String(chunk);
      return true;
    };

    try {
      const program = new Command();
      registerSecretsCommand(program, async () => {
        acquisitions += 1;
        return {
          delegationHeader: { Authorization: "Bearer openkey-owner" },
          delegationCid: "bafy-owner-openkey",
          spaceId: "secrets",
          verificationMethod: "did:key:z6MkOwner",
          expiry: "2099-01-01T00:00:00.000Z",
        };
      });
      await program.parseAsync(
        ["node", "tc", "secrets", "get", "ANTHROPIC_API_KEY"],
        { from: "node" },
      );
    } finally {
      output.write = originalWrite;
    }

    expect(acquisitions).toBe(1);
    expect(operationAttempts).toBe(2);
    expect(installedDelegations).toEqual(["bafy-owner-openkey"]);
    expect(stdout).toBe(
      [
        "{",
        '  "name": "ANTHROPIC_API_KEY",',
        `  "value": "${SECRET_VALUE_CANARY}"`,
        "}",
        "",
      ].join("\n"),
    );
  });

  test("creates a fresh owner session before the canonical authority request", async () => {
    secretAttempts.length = 0;
    operationAttempts = 0;
    installedDelegations.length = 0;
    currentSession = null;
    let acquisitions = 0;
    const program = new Command();
    registerSecretsCommand(program, async () => {
      acquisitions += 1;
      return {
        delegationHeader: { Authorization: "Bearer openkey-owner" },
        delegationCid: `bafy-owner-openkey-${acquisitions}`,
        spaceId: "secrets",
        verificationMethod: "did:key:z6MkOwner",
        expiresAt: "2099-01-01T00:00:00.000Z",
        expiry: "2099-01-01T00:00:00.000Z",
      };
    });

    await program.parseAsync(
      ["node", "tc", "secrets", "get", "ANTHROPIC_API_KEY"],
      { from: "node" },
    );

    expect(currentSession).not.toBeNull();
    expect(acquisitions).toBe(2);
    expect(operationAttempts).toBe(2);
  });
});
