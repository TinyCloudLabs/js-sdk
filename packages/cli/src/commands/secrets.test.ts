import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

const DEFAULT_NETWORK_ID =
  "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const DEFAULT_NODE_DID = "did:key:z6MkPrincipal";

type CLIErrorLike = {
  code: string;
  message: string;
  exitCode: number;
};

type NetworkDescriptorLike = {
  networkId: string;
  principal: string;
  name: string;
  members: Array<{ nodeId: string; role: "primary" | "share" }>;
  threshold: { n: number; t: number };
  state: "pending" | "generating" | "active" | "rotating" | "revoked" | "failed";
  publicEncryptionKey: string;
  alg: string;
  keyVersion: number;
  keyBackend: "local-one-of-one";
  createdAt: string;
  updatedAt: string;
};

type FakeNode = {
  did: string;
  getDefaultEncryptionNetworkId(name?: string): string;
  secrets: {
    list(options?: { scope?: string }): Promise<{ ok: true; data: string[] } | { ok: false; error: { code: string; message: string; service?: string } }>;
    get(name: string, options?: { scope?: string }): Promise<{ ok: true; data: string } | { ok: false; error: { code: string; message: string; service?: string } }>;
    put(name: string, value: string, options?: { scope?: string }): Promise<{ ok: true; data: undefined } | { ok: false; error: { code: string; message: string; service?: string } }>;
    delete(name: string, options?: { scope?: string }): Promise<{ ok: true; data: undefined } | { ok: false; error: { code: string; message: string; service?: string } }>;
  };
  getEncryptionNetwork(nameOrNetworkId: string): Promise<NetworkDescriptorLike | null>;
  ensureEncryptionNetwork(name: string): Promise<NetworkDescriptorLike>;
  delegateTo(
    recipientDid: string,
    permissions: Array<{
      service: string;
      path: string;
      actions: string[];
    }>,
  ): Promise<{
    delegation: {
      cid: string;
      path: string;
      actions: string[];
    };
    prompted: boolean;
  }>;
};

const recorded = {
  outputs: [] as unknown[],
  spinners: [] as string[],
  errors: [] as unknown[],
  resolveContexts: [] as unknown[],
  ensureAuthenticated: [] as unknown[],
  listCalls: [] as Array<{ scope?: string } | undefined>,
  getCalls: [] as Array<{ name: string; options?: { scope?: string } }>,
  putCalls: [] as Array<{ name: string; value: string; options?: { scope?: string } }>,
  deleteCalls: [] as Array<{ name: string; options?: { scope?: string } }>,
  networkShowCalls: [] as string[],
  networkInitCalls: [] as string[],
  delegateCalls: [] as Array<{
    recipientDid: string;
    permissions: Array<{
      service: string;
      path: string;
      actions: string[];
    }>;
  }>,
};

let currentNode: FakeNode;

function resetRecorded(): void {
  recorded.outputs.length = 0;
  recorded.spinners.length = 0;
  recorded.errors.length = 0;
  recorded.resolveContexts.length = 0;
  recorded.ensureAuthenticated.length = 0;
  recorded.listCalls.length = 0;
  recorded.getCalls.length = 0;
  recorded.putCalls.length = 0;
  recorded.deleteCalls.length = 0;
  recorded.networkShowCalls.length = 0;
  recorded.networkInitCalls.length = 0;
  recorded.delegateCalls.length = 0;
}

function makeDescriptor(
  networkId: string = DEFAULT_NETWORK_ID,
): NetworkDescriptorLike {
  return {
    networkId,
    principal: DEFAULT_NODE_DID,
    name: "default",
    members: [{ nodeId: DEFAULT_NODE_DID, role: "primary" }],
    threshold: { n: 1, t: 1 },
    state: "active",
    publicEncryptionKey: "AQID",
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    keyBackend: "local-one-of-one",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function makeFakeNode(overrides: {
  getResult?: { ok: false; error: { code: string; message: string; service?: string } } | { ok: true; data: string };
  listResult?: { ok: false; error: { code: string; message: string; service?: string } } | { ok: true; data: string[] };
  putResult?: { ok: false; error: { code: string; message: string; service?: string } } | { ok: true; data: undefined };
  deleteResult?: { ok: false; error: { code: string; message: string; service?: string } } | { ok: true; data: undefined };
  networkShowResult?: NetworkDescriptorLike | null;
  networkInitResult?: NetworkDescriptorLike;
  delegateResult?: { delegation: { cid: string; path: string; actions: string[] }; prompted: boolean };
} = {}): FakeNode {
  const descriptor = overrides.networkInitResult ?? makeDescriptor();
  return {
    did: DEFAULT_NODE_DID,
    getDefaultEncryptionNetworkId(name = "default") {
      return `urn:tinycloud:encryption:${DEFAULT_NODE_DID}:${name}`;
    },
    secrets: {
      async list(options?: { scope?: string }) {
        recorded.listCalls.push(options);
        return overrides.listResult ?? { ok: true as const, data: ["ANTHROPIC_API_KEY"] };
      },
      async get(name: string, options?: { scope?: string }) {
        recorded.getCalls.push({ name, options });
        return overrides.getResult ?? { ok: true as const, data: "stored-value" };
      },
      async put(name: string, value: string, options?: { scope?: string }) {
        recorded.putCalls.push({ name, value, options });
        return overrides.putResult ?? { ok: true as const, data: undefined };
      },
      async delete(name: string, options?: { scope?: string }) {
        recorded.deleteCalls.push({ name, options });
        return overrides.deleteResult ?? { ok: true as const, data: undefined };
      },
    },
    async getEncryptionNetwork(nameOrNetworkId: string) {
      recorded.networkShowCalls.push(nameOrNetworkId);
      return overrides.networkShowResult ?? descriptor;
    },
    async ensureEncryptionNetwork(name: string) {
      recorded.networkInitCalls.push(name);
      return overrides.networkInitResult ?? descriptor;
    },
    async delegateTo(recipientDid: string, permissions) {
      recorded.delegateCalls.push({ recipientDid, permissions });
      return (
        overrides.delegateResult ?? {
          delegation: {
            cid: "bafy-delegation",
            path: permissions[0]?.path ?? "",
            actions: permissions[0]?.actions ?? [],
          },
          prompted: false,
        }
      );
    },
  };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async (globalOpts: unknown) => {
      recorded.resolveContexts.push(globalOpts);
      return {
        profile: "default",
        host: "https://tinycloud.test",
      };
    },
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async (ctx: unknown, options: unknown) => {
    recorded.ensureAuthenticated.push({ ctx, options });
    return currentNode;
  },
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  withSpinner: async (_message: string, fn: () => unknown) => {
    recorded.spinners.push(_message);
    return await fn();
  },
}));

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error implements CLIErrorLike {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
    ) {
      super(message);
      this.name = "CLIError";
    }
  },
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
}));

const { registerSecretsCommand } = await import("./secrets.js");

async function runSecretsCommand(args: string[]): Promise<void> {
  const program = new Command();
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", ...args], { from: "node" });
}

beforeEach(() => {
  resetRecorded();
  currentNode = makeFakeNode();
});

describe("CLI secrets commands", () => {
  test("routes put/get/list/delete through node.secrets", async () => {
    await runSecretsCommand(["secrets", "list", "--scope", "Food Tracker"]);
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    await runSecretsCommand(["secrets", "put", "ANTHROPIC_API_KEY", "super-secret"]);
    await runSecretsCommand(["secrets", "delete", "ANTHROPIC_API_KEY"]);

    expect(recorded.listCalls).toEqual([{ scope: "Food Tracker" }]);
    expect(recorded.getCalls).toEqual([
      { name: "ANTHROPIC_API_KEY", options: undefined },
    ]);
    expect(recorded.putCalls).toEqual([
      {
        name: "ANTHROPIC_API_KEY",
        value: "super-secret",
        options: undefined,
      },
    ]);
    expect(recorded.deleteCalls).toEqual([
      { name: "ANTHROPIC_API_KEY", options: undefined },
    ]);
    expect(recorded.outputs).toEqual([
      { secrets: ["ANTHROPIC_API_KEY"], count: 1, scope: "Food Tracker" },
      { name: "ANTHROPIC_API_KEY", value: "stored-value" },
      { name: "ANTHROPIC_API_KEY", written: true },
      { name: "ANTHROPIC_API_KEY", deleted: true },
    ]);
    expect(recorded.spinners).toEqual([
      "Listing secrets...",
      "Getting secret ANTHROPIC_API_KEY...",
      "Storing secret ANTHROPIC_API_KEY...",
      "Deleting secret ANTHROPIC_API_KEY...",
    ]);
  });

  test("queries the authoritative encryption network before reporting it", async () => {
    const descriptor = makeDescriptor();
    currentNode = makeFakeNode({ networkShowResult: descriptor });

    await runSecretsCommand(["secrets", "network", "show", "default"]);

    expect(recorded.networkShowCalls).toEqual(["default"]);
    expect(recorded.outputs).toEqual([
      {
        networkId: descriptor.networkId,
        exists: true,
        descriptor,
      },
    ]);
  });

  test("ensures a decryption network and grants tinycloud.encryption/decrypt", async () => {
    const descriptor = makeDescriptor("urn:tinycloud:encryption:did:key:z6MkPrincipal:shared");
    currentNode = makeFakeNode({ networkInitResult: descriptor });

    await runSecretsCommand([
      "secrets",
      "network",
      "grant",
      "did:key:z6MkRecipient",
      "shared",
    ]);

    expect(recorded.networkInitCalls).toEqual(["shared"]);
    expect(recorded.delegateCalls).toEqual([
      {
        recipientDid: "did:key:z6MkRecipient",
        permissions: [
          {
            service: "tinycloud.encryption",
            path: descriptor.networkId,
            actions: ["decrypt"],
          },
        ],
      },
    ]);
    expect(recorded.outputs).toEqual([
      {
        networkId: descriptor.networkId,
        recipientDid: "did:key:z6MkRecipient",
        cid: "bafy-delegation",
        prompted: false,
        path: descriptor.networkId,
        actions: ["decrypt"],
      },
    ]);
  });

  test("surfaces permission errors without exposing secret values", async () => {
    currentNode = makeFakeNode({
      getResult: {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          service: "secrets",
          message: "Permission denied while reading secret",
        },
      },
    });

    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);

    expect(recorded.errors).toHaveLength(1);
    const error = recorded.errors[0] as CLIErrorLike;
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toBe("Permission denied while reading secret");
  });
});
