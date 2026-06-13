import { Command } from "commander";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEntry } from "@tinycloud/sdk-core";

type FakeNode = {
  getDefaultEncryptionNetworkId: ReturnType<typeof mock>;
  getEncryptionNetwork: ReturnType<typeof mock>;
  ensureEncryptionNetwork: ReturnType<typeof mock>;
  delegateTo: ReturnType<typeof mock>;
  useDelegation: ReturnType<typeof mock>;
  encryption: {
    decryptEnvelope: ReturnType<typeof mock>;
  };
  secrets: {
    get: ReturnType<typeof mock>;
    put: ReturnType<typeof mock>;
    delete: ReturnType<typeof mock>;
    list: ReturnType<typeof mock>;
  };
};

const context = {
  profile: "cli-test",
  host: "http://localhost:8000",
  verbose: false,
  noCache: false,
  quiet: true,
};

const outputs: unknown[] = [];
const errors: unknown[] = [];
let currentNode: FakeNode;
let currentSession: object | null = { expiresAt: "2099-01-01T00:00:00.000Z" };
let currentProfile = {
  name: "cli-test",
  host: "https://profile-host.test",
  chainId: 1,
  spaceName: "default",
  did: "did:key:z6MkProfile",
  createdAt: "2026-06-01T00:00:00.000Z",
  authMethod: "openkey" as const,
  posture: "delegate-session" as const,
  operatorType: "agent" as const,
};
const ensureAuthenticatedCalls: Array<{ ctx: unknown; options: unknown }> = [];
const delegatedCalls = {
  useDelegation: [] as Array<{
    cid: string;
    path: string;
    actions: string[];
    host?: string;
  }>,
  kvGet: [] as Array<{
    key: string;
    options?: { raw?: boolean; prefix?: string };
  }>,
  decrypt: [] as Array<{
    networkId: string;
    proofs: string[];
  }>,
};

const resolveContext = mock(async (globalOptions: Record<string, unknown>) => {
  return {
    ...context,
    ...(globalOptions.profile ? { profile: String(globalOptions.profile) } : {}),
    ...(globalOptions.host ? { host: String(globalOptions.host) } : {}),
  };
});

const outputJson = mock((data: unknown) => {
  outputs.push(data);
});

const withSpinner = mock(async <T>(_label: string, fn: () => Promise<T>) => fn());

class MockCLIError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number = 1,
    public metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CLIError";
  }
}

const handleError = mock((error: unknown) => {
  errors.push(error);
});

const ensureAuthenticated = mock(async (ctx: unknown, options: unknown) => {
  ensureAuthenticatedCalls.push({ ctx, options });
  return currentNode;
});

mock.module("@tinycloud/node-sdk", () => ({
  resolveSecretListPrefix: (options?: { scope?: string }) =>
    options?.scope ? `vault/secrets/scoped/${options.scope.toLowerCase().replaceAll(/\s+/g, "-")}/` : "vault/secrets/",
  resolveSecretPath: (name: string, options?: { scope?: string }) => ({
    permissionPaths: {
      vault: options?.scope
        ? `vault/secrets/scoped/${options.scope.toLowerCase().replaceAll(/\s+/g, "-")}/${name}`
        : `vault/secrets/${name}`,
    },
  }),
  principalDidEquals: (a: string, b: string) =>
    a.split("#")[0].toLowerCase() === b.split("#")[0].toLowerCase(),
}));

mock.module(new URL("../../../packages/cli/src/config/profiles.ts", import.meta.url).pathname, () => ({
  ProfileManager: {
    resolveContext,
    getProfile: async () => currentProfile,
    getSession: async () => currentSession,
  },
}));

mock.module(new URL("../../../packages/cli/src/output/formatter.ts", import.meta.url).pathname, () => ({
  outputJson,
  withSpinner,
}));

mock.module(new URL("../../../packages/cli/src/output/errors.ts", import.meta.url).pathname, () => ({
  handleError,
  CLIError: MockCLIError,
}));

mock.module(new URL("../../../packages/cli/src/lib/sdk.ts", import.meta.url).pathname, () => ({
  ensureAuthenticated,
}));

mock.module(new URL("../../../packages/cli/src/commands/auth.ts", import.meta.url).pathname, () => ({
  ensureDelegationAuthority: async () => undefined,
  refreshOpenKeySession: async () => undefined,
}));

const { registerSecretsCommand } = await import("../../../packages/cli/src/commands/secrets.ts");

function makeNetworkDescriptor(name = "default") {
  const ownerDid = "did:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
  return {
    networkId: `urn:tinycloud:encryption:${ownerDid}:${name}`,
    ownerDid,
    name,
    members: [
      {
        nodeId: "did:key:z6MkvuHBMFVXNwPNHmT3RBCdJhAmQQhvEUjM1138YkwdNcXN",
        role: "primary",
      },
    ],
    threshold: { n: 1, t: 1 },
    state: "active",
    publicEncryptionKey: "public-key",
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    keyBackend: "local-one-of-one",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

const DEFAULT_NETWORK_ID = makeNetworkDescriptor().networkId;

function makeNode(overrides: {
  delegatedGetResult?: { ok: true; data: { data: string } } | { ok: false; error: { code: string; message: string } };
  decryptResult?: { ok: true; data: Uint8Array } | { ok: false; error: { code: string; message: string } };
} = {}): FakeNode {
  return {
    getDefaultEncryptionNetworkId: mock((name = "default") => makeNetworkDescriptor(name).networkId),
    getEncryptionNetwork: mock(async (nameOrNetworkId: string) => {
      if (nameOrNetworkId === "missing") {
        return null;
      }
      if (nameOrNetworkId.startsWith("urn:tinycloud:encryption:")) {
        return makeNetworkDescriptor(nameOrNetworkId.slice(nameOrNetworkId.lastIndexOf(":") + 1));
      }
      return makeNetworkDescriptor(nameOrNetworkId || "default");
    }),
    ensureEncryptionNetwork: mock(async (name = "default") => makeNetworkDescriptor(name)),
    delegateTo: mock(async (recipientDid: string, permissions: PermissionEntry[]) => ({
      prompted: false,
      delegation: {
        cid: "bafy-grant",
        delegateDID: recipientDid,
        path: permissions[0].path,
        actions: permissions[0].actions.map((action) =>
          action.includes("/") ? action : `tinycloud.encryption/${action}`,
        ),
      },
    })),
    useDelegation: mock(async (delegation: {
      cid: string;
      path: string;
      actions: string[];
      host?: string;
    }) => {
      delegatedCalls.useDelegation.push(delegation);
      return {
        kv: {
          get: mock(async (key: string, options?: { raw?: boolean; prefix?: string }) => {
            delegatedCalls.kvGet.push({ key, options });
            return overrides.delegatedGetResult ?? {
              ok: true,
              data: {
                data: JSON.stringify({
                  v: 1,
                  networkId: DEFAULT_NETWORK_ID,
                  alg: "x25519-aes256gcm/v1",
                  encryptedSymmetricKey: "enc-key",
                  ciphertext: "ciphertext",
                  keyVersion: 1,
                }),
              },
            };
          }),
        },
      };
    }),
    encryption: {
      decryptEnvelope: mock(async (envelope: { networkId: string }, proof: { proofs: string[] }) => {
        delegatedCalls.decrypt.push({ networkId: envelope.networkId, proofs: proof.proofs });
        return overrides.decryptResult ?? {
          ok: true,
          data: new TextEncoder().encode(JSON.stringify({ value: "delegated-value" })),
        };
      }),
    },
    secrets: {
      get: mock(async (name: string, options?: { scope?: string }) => ({
        ok: true,
        data: options?.scope ? `scoped:${name}` : `value:${name}`,
      })),
      put: mock(async () => ({ ok: true, data: undefined })),
      delete: mock(async () => ({ ok: true, data: undefined })),
      list: mock(async (options?: { scope?: string }) => ({
        ok: true,
        data: options?.scope ? ["SCOPED_KEY"] : ["ANTHROPIC_API_KEY"],
      })),
    },
  };
}

function makeDelegatedSecretEnvelope(networkId = DEFAULT_NETWORK_ID) {
  return {
    v: 1,
    networkId,
    alg: "x25519-aes256gcm/v1",
    encryptedSymmetricKey: "enc-key",
    ciphertext: "ciphertext",
    keyVersion: 1,
  };
}

function makeDelegationArtifact(params: {
  cid: string;
  host: string;
  secretPath: string;
  networkId: string;
  secretSpace?: string;
}): {
  cid: string;
  delegationHeader: { Authorization: string };
  spaceId: string;
  path: string;
  actions: string[];
  resources: Array<{
    service: string;
    space?: string;
    path: string;
    actions: string[];
  }>;
  expiry: string;
  delegateDID: string;
  ownerAddress: string;
  chainId: number;
  host: string;
} {
  return {
    cid: params.cid,
    delegationHeader: { Authorization: "owner-token" },
    spaceId: "tinycloud:pkh:eip155:1:0xowner:secrets",
    path: params.secretPath,
    actions: ["tinycloud.kv/get"],
    resources: [
      {
        service: "kv",
        space: params.secretSpace ?? "secrets",
        path: params.secretPath,
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "encryption",
        path: params.networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ],
    expiry: "2026-06-30T00:00:00.000Z",
    delegateDID: "did:key:z6MkRecipient",
    ownerAddress: "0xowner",
    chainId: 1,
    host: params.host,
  };
}

async function runCommand(args: string[], options: { host?: string | null } = {}): Promise<void> {
  outputs.length = 0;
  errors.length = 0;
  const program = new Command();
  program
    .option("-p, --profile <name>", "Profile to use")
    .option("-H, --host <url>", "TinyCloud node URL")
    .option("-v, --verbose", "Enable verbose output")
    .option("--no-cache", "Disable caching")
    .option("-q, --quiet", "Suppress non-essential output")
    .option("--json", "Force JSON output");
  registerSecretsCommand(program);
  const parsedArgs = ["--profile", "cli-test"];
  if (options.host !== null) {
    parsedArgs.push("--host", options.host ?? "http://localhost:8000");
  }
  parsedArgs.push("--json", "--quiet", ...args);
  await program.parseAsync(parsedArgs, {
    from: "user",
  });
}

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  ensureAuthenticatedCalls.length = 0;
  delegatedCalls.useDelegation.length = 0;
  delegatedCalls.kvGet.length = 0;
  delegatedCalls.decrypt.length = 0;
  context.host = "http://localhost:8000";
  currentSession = { expiresAt: "2099-01-01T00:00:00.000Z" };
  currentProfile = {
    name: "cli-test",
    host: "https://profile-host.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:z6MkProfile",
    createdAt: "2026-06-01T00:00:00.000Z",
    authMethod: "openkey",
    posture: "delegate-session",
    operatorType: "agent",
  };
  currentNode = makeNode();
});

describe("secrets CLI", () => {
  test("stores, reads, lists, and deletes network-encrypted secrets", async () => {
    currentNode = makeNode();

    await runCommand(["secrets", "network", "init"]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      networkId: makeNetworkDescriptor().networkId,
      state: "active",
    });
    expect(currentNode.ensureEncryptionNetwork).toHaveBeenCalledWith("default");

    await runCommand(["secrets", "network", "show"]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      networkId: makeNetworkDescriptor().networkId,
      exists: true,
    });
    expect(currentNode.getEncryptionNetwork).toHaveBeenCalledWith("default");

    await runCommand(["secrets", "put", "ANTHROPIC_API_KEY", "super-secret"]);
    expect(outputs).toEqual([{ name: "ANTHROPIC_API_KEY", written: true }]);
    expect(currentNode.secrets.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "super-secret", undefined);

    await runCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    expect(outputs).toEqual([{ name: "ANTHROPIC_API_KEY", value: "value:ANTHROPIC_API_KEY" }]);
    expect(currentNode.secrets.get).toHaveBeenCalledWith("ANTHROPIC_API_KEY", undefined);

    await runCommand(["secrets", "list", "--space", "Food Tracker"]);
    expect(outputs).toEqual([{ secrets: ["SCOPED_KEY"], count: 1, scope: "Food Tracker" }]);
    expect(currentNode.secrets.list).toHaveBeenCalledWith({ scope: "Food Tracker" });

    await runCommand(["secrets", "delete", "ANTHROPIC_API_KEY"]);
    expect(outputs).toEqual([{ name: "ANTHROPIC_API_KEY", deleted: true }]);
    expect(currentNode.secrets.delete).toHaveBeenCalledWith("ANTHROPIC_API_KEY", undefined);
  });

  test("reads a delegated secret from a file path and uses the delegation host", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tc-cli-delegation-file-"));
    const secretName = "ANTHROPIC_API_KEY";
    const secretPath = `vault/secrets/${secretName}`;
    const delegationHost = "https://delegation-host.test";
    const delegation = makeDelegationArtifact({
      cid: "bafy-file-delegation",
      host: delegationHost,
      secretPath,
      networkId: DEFAULT_NETWORK_ID,
    });
    const delegationPath = join(tempDir, "delegation.json");

    context.host = "https://profile-host.test";
    await writeFile(delegationPath, `${JSON.stringify(delegation, null, 2)}\n`, "utf8");

    try {
      currentNode = makeNode();

      await runCommand(["secrets", "get", secretName, "--delegation", delegationPath], { host: null });

      expect(ensureAuthenticatedCalls).toHaveLength(1);
      expect((ensureAuthenticatedCalls[0].ctx as { host?: string }).host).toBe(delegationHost);
      expect(delegatedCalls.useDelegation).toHaveLength(1);
      expect(delegatedCalls.useDelegation[0]).toMatchObject({
        cid: "bafy-file-delegation",
        path: secretPath,
        actions: ["tinycloud.kv/get"],
        host: delegationHost,
      });
      expect(delegatedCalls.kvGet).toEqual([
        { key: secretPath, options: { raw: true, prefix: "" } },
      ]);
      expect(delegatedCalls.decrypt).toEqual([
        { networkId: DEFAULT_NETWORK_ID, proofs: ["bafy-file-delegation"] },
      ]);
      expect(outputs).toEqual([
        { name: secretName, value: "delegated-value" },
      ]);
      expect(currentNode.secrets.get).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reads a delegated secret from an imported owner profile", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "tc-cli-home-"));
    const secretName = "OPENAI_API_KEY";
    const secretPath = `vault/secrets/${secretName}`;
    const delegationHost = "https://delegation-owner.test";
    const delegation = makeDelegationArtifact({
      cid: "bafy-imported-delegation",
      host: delegationHost,
      secretPath,
      networkId: DEFAULT_NETWORK_ID,
    });

    const previousHome = process.env.HOME;
    const profileDir = join(tempHome, ".tinycloud", "profiles", "owner-profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, "additional-delegations.json"),
      `${JSON.stringify([{ delegation }], null, 2)}\n`,
      "utf8",
    );

    try {
      process.env.HOME = tempHome;
      context.host = "https://profile-host.test";
      currentNode = makeNode();

      await runCommand(["secrets", "get", secretName, "--delegation", "owner-profile"], { host: null });

      expect(ensureAuthenticatedCalls).toHaveLength(1);
      expect((ensureAuthenticatedCalls[0].ctx as { host?: string }).host).toBe(delegationHost);
      expect(delegatedCalls.useDelegation).toHaveLength(1);
      expect(delegatedCalls.useDelegation[0]).toMatchObject({
        cid: "bafy-imported-delegation",
        path: secretPath,
        actions: ["tinycloud.kv/get"],
        host: delegationHost,
      });
      expect(delegatedCalls.kvGet).toEqual([
        { key: secretPath, options: { raw: true, prefix: "" } },
      ]);
      expect(delegatedCalls.decrypt).toEqual([
        { networkId: DEFAULT_NETWORK_ID, proofs: ["bafy-imported-delegation"] },
      ]);
      expect(outputs).toEqual([
        { name: secretName, value: "delegated-value" },
      ]);
      expect(currentNode.secrets.get).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("reports a delegated secret path mismatch explicitly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tc-cli-delegation-mismatch-"));
    const secretName = "ANTHROPIC_API_KEY";
    const secretPath = `vault/secrets/${secretName}`;
    const delegation = makeDelegationArtifact({
      cid: "bafy-wrong-path",
      host: "https://delegation-owner.test",
      secretPath: "vault/secrets/OTHER_SECRET",
      networkId: DEFAULT_NETWORK_ID,
    });
    const delegationPath = join(tempDir, "delegation.json");

    await writeFile(delegationPath, `${JSON.stringify(delegation, null, 2)}\n`, "utf8");

    try {
      currentNode = makeNode();
      await runCommand(["secrets", "get", secretName, "--delegation", delegationPath], { host: null });

      expect(outputs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(MockCLIError);
      expect((errors[0] as MockCLIError).code).toBe("PERMISSION_DENIED");
      expect((errors[0] as MockCLIError).message).toContain(secretPath);
      expect(delegatedCalls.useDelegation).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports a delegated secret wrong-space mismatch explicitly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tc-cli-delegation-wrong-space-"));
    const secretName = "ANTHROPIC_API_KEY";
    const secretPath = `vault/secrets/${secretName}`;
    const delegation = makeDelegationArtifact({
      cid: "bafy-wrong-space",
      host: "https://delegation-owner.test",
      secretPath,
      networkId: DEFAULT_NETWORK_ID,
      secretSpace: "other-space",
    });
    const delegationPath = join(tempDir, "delegation.json");

    await writeFile(delegationPath, `${JSON.stringify(delegation, null, 2)}\n`, "utf8");

    try {
      currentNode = makeNode();

      await runCommand(["secrets", "get", secretName, "--delegation", delegationPath], { host: null });

      expect(outputs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(MockCLIError);
      expect((errors[0] as MockCLIError).code).toBe("PERMISSION_DENIED");
      expect((errors[0] as MockCLIError).message).toContain("secrets space");
      expect(delegatedCalls.useDelegation).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports a missing decrypt capability explicitly", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "tc-cli-home-"));
    const secretName = "ANTHROPIC_API_KEY";
    const secretPath = `vault/secrets/${secretName}`;
    const delegation = makeDelegationArtifact({
      cid: "bafy-no-decrypt",
      host: "https://delegation-owner.test",
      secretPath,
      networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0xowner:alternate",
    });

    const previousHome = process.env.HOME;
    const profileDir = join(tempHome, ".tinycloud", "profiles", "owner-profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, "additional-delegations.json"),
      `${JSON.stringify([{ delegation }], null, 2)}\n`,
      "utf8",
    );

    try {
      process.env.HOME = tempHome;
      currentNode = makeNode();

      await runCommand(["secrets", "get", secretName, "--delegation", "owner-profile"], { host: null });

      expect(delegatedCalls.useDelegation).toHaveLength(1);
      expect(delegatedCalls.kvGet).toEqual([
        { key: secretPath, options: { raw: true, prefix: "" } },
      ]);
      expect(delegatedCalls.decrypt).toHaveLength(0);
      expect(outputs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(MockCLIError);
      expect((errors[0] as MockCLIError).code).toBe("PERMISSION_DENIED");
      expect((errors[0] as MockCLIError).message).toContain("tinycloud.encryption/decrypt");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("reports a missing delegated secret as not found", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tc-cli-delegation-missing-"));
    const secretName = "ANTHROPIC_API_KEY";
    const secretPath = `vault/secrets/${secretName}`;
    const delegation = makeDelegationArtifact({
      cid: "bafy-missing-secret",
      host: "https://delegation-owner.test",
      secretPath,
      networkId: DEFAULT_NETWORK_ID,
    });
    const delegationPath = join(tempDir, "delegation.json");

    await writeFile(delegationPath, `${JSON.stringify(delegation, null, 2)}\n`, "utf8");

    try {
      currentNode = makeNode({
        delegatedGetResult: {
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: "missing",
          },
        },
      });

      await runCommand(["secrets", "get", secretName, "--delegation", delegationPath], { host: null });

      expect(outputs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(MockCLIError);
      expect((errors[0] as MockCLIError).code).toBe("NOT_FOUND");
      expect((errors[0] as MockCLIError).message).toBe(`Secret "${secretName}" not found`);
      expect(delegatedCalls.decrypt).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects a malformed delegation source explicitly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tc-cli-delegation-invalid-"));
    const secretName = "ANTHROPIC_API_KEY";
    const badPath = join(tempDir, "delegation.json");

    await writeFile(badPath, "{ not valid json }\n", "utf8");

    try {
      currentNode = makeNode();

      await runCommand(["secrets", "get", secretName, "--delegation", badPath], { host: null });

      expect(outputs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(MockCLIError);
      expect((errors[0] as MockCLIError).code).toBe("INVALID_DELEGATION_SOURCE");
      expect((errors[0] as MockCLIError).message).toContain("must be valid JSON");
      expect(delegatedCalls.useDelegation).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("grants decrypt permission for the default encryption network", async () => {
    currentNode = makeNode();

    await runCommand(["secrets", "network", "grant", "did:pkh:eip155:1:0x9999999999999999999999999999999999999999"]);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      networkId: makeNetworkDescriptor().networkId,
      recipientDid: "did:pkh:eip155:1:0x9999999999999999999999999999999999999999",
      cid: "bafy-grant",
      prompted: false,
      path: makeNetworkDescriptor().networkId,
      actions: ["tinycloud.encryption/decrypt"],
    });
    expect(currentNode.ensureEncryptionNetwork).toHaveBeenCalledWith("default");
    expect(currentNode.delegateTo).toHaveBeenCalledWith(
      "did:pkh:eip155:1:0x9999999999999999999999999999999999999999",
      [
        {
          service: "tinycloud.encryption",
          path: makeNetworkDescriptor().networkId,
          actions: ["decrypt"],
        },
      ],
    );
  });

  test("surfaces permission errors without exposing secret values", async () => {
    currentNode = makeNode();
    currentNode.secrets.get = mock(async () => ({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        service: "secrets",
        message: "Permission denied for ANTHROPIC_API_KEY",
      },
    }));

    await runCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);

    expect(outputs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MockCLIError);
    expect((errors[0] as MockCLIError).code).toBe("PERMISSION_DENIED");
    expect((errors[0] as MockCLIError).message).toBe("Permission denied for ANTHROPIC_API_KEY");
  });
});
