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
const installedDelegations: string[] = [];

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
    getSession: async () => ({ expiresAt: "2099-01-01T00:00:00.000Z" }),
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
    expect(secretAttempts).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]);
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
});
