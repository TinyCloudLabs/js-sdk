import { Command } from "commander";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";

type FakeNode = {
  getDefaultEncryptionNetworkId: ReturnType<typeof mock>;
  getEncryptionNetwork: ReturnType<typeof mock>;
  ensureEncryptionNetwork: ReturnType<typeof mock>;
  delegateTo: ReturnType<typeof mock>;
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

const ensureAuthenticated = mock(async () => currentNode);

mock.module(new URL("../../../packages/cli/src/config/profiles.ts", import.meta.url).pathname, () => ({
  ProfileManager: {
    resolveContext,
    getProfile: async () => ({
      name: context.profile,
      host: context.host,
      chainId: 1,
      spaceName: "default",
      did: "did:key:z6MkSession",
      createdAt: "2026-06-01T00:00:00.000Z",
      authMethod: "openkey",
      posture: "delegate-session",
      operatorType: "agent",
    }),
    getSession: async () => null,
  },
}));

mock.module(new URL("../../../packages/cli/src/output/formatter.ts", import.meta.url).pathname, () => ({
  formatField: (label: string, value: unknown) => `${label}: ${String(value)}`,
  formatTable: (_headers: string[], rows: string[][]) =>
    rows.map((row) => row.join("  ")).join("\n"),
  isInteractive: () => false,
  outputJson,
  shouldOutputJson: () => true,
  withSpinner,
}));

mock.module(new URL("../../../packages/cli/src/output/errors.ts", import.meta.url).pathname, () => ({
  handleError,
  CLIError: MockCLIError,
}));

mock.module(new URL("../../../packages/cli/src/lib/sdk.ts", import.meta.url).pathname, () => ({
  ensureAuthenticated,
}));

mock.module("@tinycloud/node-sdk", () => ({
  buildSpaceUri: (owner: string, name: string) => `${owner}:${name}`,
  canonicalizeAddress: (address: string) => address,
  makePkhSpaceId: (address: string, chainId = 1, name = "default") =>
    `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
  parsePkhDid: (did: string) => {
    const match = did.match(/^did:pkh:eip155:(\d+):(.+)$/);
    return match ? { chainId: Number(match[1]), address: match[2] } : null;
  },
  parseSpaceUri: (space: string) => {
    const match = space.match(/^(tinycloud:pkh:eip155:\d+:[^:]+):([^:]+)$/);
    return match ? { owner: match[1], name: match[2] } : null;
  },
  expandActionShortNames: (permission: { actions: string[] }) => permission.actions,
  isCapabilitySubset: () => false,
  PrivateKeySigner: class PrivateKeySigner {},
  pkhDid: (address: string, chainId = 1) => `did:pkh:eip155:${chainId}:${address}`,
  resolveManifest: () => ({ permissions: [] }),
  resolveSecretListPrefix: (options?: { scope?: string }) =>
    options?.scope ? `vault/secrets/scoped/${options.scope.toLowerCase().replaceAll(/\s+/g, "-")}/` : "vault/secrets/",
  resolveSecretPath: (name: string, options?: { scope?: string }) => ({
    permissionPaths: {
      vault: options?.scope
        ? `vault/secrets/scoped/${options.scope.toLowerCase().replaceAll(/\s+/g, "-")}/${name}`
        : `vault/secrets/${name}`,
    },
  }),
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

function makeNode(): FakeNode {
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

async function runCommand(args: string[]): Promise<void> {
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
  await program.parseAsync(["--profile", "cli-test", "--host", "http://localhost:8000", "--json", "--quiet", ...args], {
    from: "user",
  });
}

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
