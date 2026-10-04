import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

const TEST_HOME = await mkdtemp(join(tmpdir(), "tc-secrets-owner-retry-"));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

const SECRET_VALUE_CANARY = "tc-191-owner-secret-value-canary";
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const wasm = new NodeWasmBindings();
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "secrets");
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const sessionDid = manager.getDID("default");
const NETWORK_ID = `urn:tinycloud:encryption:${ownerDid}:default`;
const openKey = openKeyDelegate({ wasm, signer, sessionKey: key, sessionDid });
const KV_GET: PermissionEntry = {
  service: "tinycloud.kv",
  space: "secrets",
  path: "vault/secrets/ANTHROPIC_API_KEY",
  actions: ["tinycloud.kv/get"],
};
// The canonical operation reports raw decrypt without a space.
const DECRYPT = { service: "tinycloud.encryption", path: NETWORK_ID, actions: ["tinycloud.encryption/decrypt"] } as PermissionEntry;
let firstMissing: PermissionEntry[] = [KV_GET, DECRYPT];

const profile = {
  name: "default",
  host: "https://node.tinycloud.test",
  chainId: 1,
  spaceName: "default",
  did: ownerDid,
  sessionDid,
  ownerDid,
  spaceId,
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

async function signedApproval() {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "vault/secrets/ANTHROPIC_API_KEY": ["tinycloud.kv/get"] } },
    rawAbilities: { [NETWORK_ID]: ["tinycloud.encryption/decrypt"] },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 3600_000).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  return {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    address, chainId: 1, spaceId, verificationMethod: sessionDid, siwe: prepared.siwe, signature,
  };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    // Real logins commit under the profile lock; these mocks keep state in memory.
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    resolveContext: async () => ({ profile: "default", host: profile.host }),
    getProfile: async () => profile,
    getSession: async () => currentSession,
    setSession: async (_profile: string, session: Record<string, unknown>) => {
      currentSession = session;
    },
    setKey: async () => undefined,
    setProfile: async () => undefined,
    ensureProfileDir: async (name: string) => {
      const directory = join(TEST_HOME, ".tinycloud", "profiles", name);
      await mkdir(directory, { recursive: true });
      return directory;
    },
    getKey: async () => key,
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
        missing: firstMissing,
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
  keyToDID: () => sessionDid,
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
  // The person sees prompts on stderr even when stdout is piped or redirected.
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  });
  afterEach(() => {
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  });

  const CAPABILITIES_READ = { service: "tinycloud.capabilities", space: "secrets", path: "", actions: ["tinycloud.capabilities/read"] };
  const RAW_DECRYPT = { ...DECRYPT, space: "encryption" };
  test.each([
    ["a missing read and decrypt", [KV_GET, DECRYPT], [CAPABILITIES_READ, KV_GET, RAW_DECRYPT]],
    ["a missing decrypt only", [DECRYPT], [CAPABILITIES_READ, RAW_DECRYPT]],
  ])("%s: OpenKey signs the escalation once and the secret is retried exactly once", async (_label, missing, request) => {
    secretAttempts.length = 0;
    operationAttempts = 0;
    installedDelegations.length = 0;
    openKey.requests.length = 0;
    firstMissing = missing;
    let acquisitions = 0;
    let grantedCid = "";
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
      registerSecretsCommand(program, async (did, options) => {
        acquisitions += 1;
        const approval = await openKey.delegate(did, options);
        grantedCid = approval.delegationCid;
        return approval;
      });
      await program.parseAsync(
        ["node", "tc", "secrets", "get", "ANTHROPIC_API_KEY"],
        { from: "node" },
      );
    } finally {
      output.write = originalWrite;
    }

    expect(openKey.requests).toEqual([request]);
    expect(acquisitions).toBe(1);
    expect(operationAttempts).toBe(2);
    expect(installedDelegations).toEqual([grantedCid]);
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
    firstMissing = [KV_GET, DECRYPT];
    currentSession = null;
    let acquisitions = 0;
    const program = new Command();
    registerSecretsCommand(program, async () => {
      acquisitions += 1;
      return signedApproval();
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
