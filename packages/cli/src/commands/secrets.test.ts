import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TCWSessionManager, completeSessionSetup, makeSpaceId, prepareSession, signEthereumMessage } from "@tinycloud/node-sdk-wasm";
import { Command } from "commander";
import { readSession, withTinyCloudStateRoot, writeSession } from "@tinycloud/operations/state";

const DEFAULT_NETWORK_ID =
  "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const DEFAULT_NODE_DID = "did:key:z6MkPrincipal";
const SECRET_VALUE_CANARY = "tc-191-secret-value-canary";

type CLIErrorLike = {
  code: string;
  message: string;
  exitCode: number;
  metadata?: Record<string, unknown>;
};

type SecretResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; service?: string } };

type NetworkDescriptorLike = {
  networkId: string;
  ownerDid: string;
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
  getEncryptionNetworkIdForSpace(spaceId: string, name?: string): string;
  secretsForSpace(spaceId: string): FakeNode["secrets"];
  readSecret(input: { space: string; name: string; scope?: string }): Promise<
    | { status: "ok"; value: string }
    | { status: "not_found" }
    | { status: "permission_required" }
    | { status: "read_failed" }
  >;
  secrets: {
    list(options?: { scope?: string }): Promise<{ ok: true; data: string[] } | { ok: false; error: { code: string; message: string; service?: string } }>;
    get(name: string, options?: { scope?: string }): Promise<{ ok: true; data: string } | { ok: false; error: { code: string; message: string; service?: string } }>;
    put(name: string, value: string, options?: { scope?: string }): Promise<{ ok: true; data: undefined } | { ok: false; error: { code: string; message: string; service?: string } }>;
    delete(name: string, options?: { scope?: string }): Promise<{ ok: true; data: undefined } | { ok: false; error: { code: string; message: string; service?: string } }>;
  };
  encryption: {
    decryptEnvelope(
      envelope: unknown,
      options: { proofs: string[] },
    ): Promise<SecretResult<Uint8Array>>;
  };
  useDelegation(delegation: unknown): Promise<{
    kv: {
      get(
        path: string,
        options: { raw: boolean; prefix: string },
      ): Promise<{ ok: true; data: { data: string } } | { ok: false; error: { code: string; message: string } }>;
    };
  }>;
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
  secretsForSpaceCalls: [] as string[],
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
  permissionRequests: [] as Array<{
    profile: string;
    requested: Array<{
      service: string;
      space?: string;
      path: string;
      actions: string[];
      skipPrefix?: boolean;
    }>;
  }>,
  sessionRefreshes: [] as Array<{ profile: string; host: string }>,
  delegatedKvGets: [] as Array<{ path: string; options: { raw: boolean; prefix: string } }>,
  decryptEnvelopeCalls: [] as Array<{ envelope: unknown; options: { proofs: string[] } }>,
};
let canonicalResultOverride: unknown | null = null;

let currentNode: FakeNode;
let outputJsonRequested = false;
let interactive = true;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
let currentSession: object | null = {
  expiresAt: "2099-01-01T00:00:00.000Z",
  address: "0x0000000000000000000000000000000000000001",
  chainId: 1,
};
let currentProfile = {
  name: "default",
  host: "https://tinycloud.test",
  chainId: 1,
  spaceName: "default",
  did: "did:key:z6MkSession",
  createdAt: "2026-06-01T00:00:00.000Z",
  authMethod: "openkey" as const,
  posture: "owner-openkey" as const,
  operatorType: "human" as const,
};
let useStoredSession = false;

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
  recorded.secretsForSpaceCalls.length = 0;
  recorded.networkShowCalls.length = 0;
  recorded.networkInitCalls.length = 0;
  recorded.delegateCalls.length = 0;
  recorded.permissionRequests.length = 0;
  recorded.sessionRefreshes.length = 0;
  recorded.delegatedKvGets.length = 0;
  recorded.decryptEnvelopeCalls.length = 0;
  canonicalResultOverride = null;
}

async function expiredSignedSession() {
  const privateKey = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
  const address = "0xe8c2ab8468210C4b507C0563A10da60990eaa792";
  const jwk = JSON.parse(new TCWSessionManager().jwk("default")!);
  const prepared = prepareSession({
    abilities: { kv: { "vault/secrets/KEY": ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "tinycloud.test",
    spaceId: makeSpaceId(address, 1, "secrets"), jwk,
    issuedAt: "2026-06-02T17:00:00.000Z",
    expirationTime: "2026-06-02T17:30:53.120Z",
  });
  const signature = `0x${signEthereumMessage(prepared.siwe, privateKey).replace(/^0x/, "")}`;
  return { ...completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature, jwk, address, chainId: 1 };
}

function makeDescriptor(
  networkId: string = DEFAULT_NETWORK_ID,
): NetworkDescriptorLike {
  return {
    networkId,
    ownerDid: DEFAULT_NODE_DID,
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
  getResult?: SecretResult<string> | SecretResult<string>[];
  listResult?: SecretResult<string[]> | SecretResult<string[]>[];
  listError?: Error | Error[];
  putResult?: SecretResult<undefined> | SecretResult<undefined>[];
  deleteResult?: SecretResult<undefined> | SecretResult<undefined>[];
  networkShowResult?: NetworkDescriptorLike | null;
  networkInitResult?: NetworkDescriptorLike;
  delegateResult?: { delegation: { cid: string; path: string; actions: string[] }; prompted: boolean };
  delegatedKvResult?: { ok: true; data: { data: string } } | { ok: false; error: { code: string; message: string } };
  decryptResult?: SecretResult<Uint8Array>;
} = {}): FakeNode {
  const descriptor = overrides.networkInitResult ?? makeDescriptor();
  return {
    did: DEFAULT_NODE_DID,
    getDefaultEncryptionNetworkId(name = "default") {
      return `urn:tinycloud:encryption:${DEFAULT_NODE_DID}:${name}`;
    },
    getEncryptionNetworkIdForSpace(spaceId: string, name = "default") {
      if (spaceId.startsWith("tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:")) {
        return `urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:${name}`;
      }
      return `urn:tinycloud:encryption:${DEFAULT_NODE_DID}:${name}`;
    },
    secretsForSpace(spaceId: string) {
      recorded.secretsForSpaceCalls.push(spaceId);
      return this.secrets;
    },
    secrets: {
      async list(options?: { scope?: string }) {
        recorded.listCalls.push(options);
        const listError = nextError(overrides.listError);
        if (listError) throw listError;
        return nextResult(overrides.listResult, { ok: true as const, data: ["ANTHROPIC_API_KEY"] });
      },
      async get(name: string, options?: { scope?: string }) {
        recorded.getCalls.push({ name, options });
        return nextResult(overrides.getResult, { ok: true as const, data: "stored-value" });
      },
      async put(name: string, value: string, options?: { scope?: string }) {
        recorded.putCalls.push({ name, value, options });
        return nextResult(overrides.putResult, { ok: true as const, data: undefined });
      },
      async delete(name: string, options?: { scope?: string }) {
        recorded.deleteCalls.push({ name, options });
        return nextResult(overrides.deleteResult, { ok: true as const, data: undefined });
      },
    },
    async readSecret(input: { space: string; name: string; scope?: string }) {
      const service = input.space === "secrets" ? this.secrets : this.secretsForSpace(input.space);
      const result = await service.get(
        input.name,
        input.scope === undefined ? undefined : { scope: input.scope },
      );
      if (result.ok) return { status: "ok" as const, value: result.data };
      if (result.error.code === "NOT_FOUND" || result.error.code === "KEY_NOT_FOUND") {
        return { status: "not_found" as const };
      }
      if (result.error.code === "PERMISSION_DENIED") {
        return { status: "permission_required" as const };
      }
      return { status: "read_failed" as const };
    },
    encryption: {
      async decryptEnvelope(envelope: unknown, options: { proofs: string[] }) {
        recorded.decryptEnvelopeCalls.push({ envelope, options });
        return overrides.decryptResult ?? {
          ok: true as const,
          data: new TextEncoder().encode(JSON.stringify({ value: "delegated-value" })),
        };
      },
    },
    async useDelegation() {
      return {
        kv: {
          async get(path: string, options: { raw: boolean; prefix: string }) {
            recorded.delegatedKvGets.push({ path, options });
            return overrides.delegatedKvResult ?? {
              ok: true as const,
              data: {
                data: JSON.stringify({ networkId: DEFAULT_NETWORK_ID }),
              },
            };
          },
        },
      };
    },
    async getEncryptionNetwork(nameOrNetworkId: string) {
      recorded.networkShowCalls.push(nameOrNetworkId);
      return Object.hasOwn(overrides, "networkShowResult")
        ? overrides.networkShowResult!
        : descriptor;
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

function nextError(error: Error | Error[] | undefined): Error | null {
  if (Array.isArray(error)) {
    return error.shift() ?? null;
  }
  return error ?? null;
}

function nextResult<T>(
  result: SecretResult<T> | SecretResult<T>[] | undefined,
  fallback: SecretResult<T>,
): SecretResult<T> {
  if (Array.isArray(result)) {
    return result.shift() ?? fallback;
  }
  return result ?? fallback;
}

mock.module("@tinycloud/node-sdk", () => ({
  canonicalizeAddress: (address: string) => address.toLowerCase(),
  makePkhSpaceId: (address: string, chainId: number, name: string) =>
    `tinycloud:pkh:eip155:${chainId}:${address.toLowerCase()}:${name}`,
  parsePkhDid: (did: string) => {
    const match = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(did);
    return match === null
      ? null
      : {
        method: "pkh",
        namespace: "eip155",
        chainId: Number(match[1]),
        address: match[2]!.toLowerCase(),
      };
  },
  parseSpaceUri: (space: string) => {
    const match = /^tinycloud:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40}):(.+)$/.exec(space);
    if (match !== null) {
      return {
        owner: `did:pkh:eip155:${match[1]}:${match[2]!.toLowerCase()}`,
        name: match[3]!,
        chainId: match[1]!,
        address: match[2]!.toLowerCase(),
      };
    }
    return /^[a-zA-Z0-9_-]+$/.test(space) ? { owner: "", name: space } : null;
  },
  NodeWasmBindings: class NodeWasmBindings {
    parseRecapFromSiwe(): unknown[] {
      return [];
    }
  },
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

mock.module("../lib/permissions.js", () => ({
  loadAdditionalDelegations: async () => [],
  permissionsFromDelegation: (delegation: {
    spaceId: string;
    path: string;
    actions: string[];
    resources?: Array<{
      service: string;
      space?: string;
      path: string;
      actions: string[];
    }>;
  }) => {
    if (Array.isArray(delegation.resources) && delegation.resources.length > 0) {
      return delegation.resources.map((resource) => ({
        service: resource.service.startsWith("tinycloud.")
          ? resource.service
          : `tinycloud.${resource.service}`,
        space: resource.space ?? delegation.spaceId,
        path: resource.path,
        actions: [...resource.actions],
      }));
    }

    return [{
      service: "tinycloud.kv",
      space: delegation.spaceId,
      path: delegation.path,
      actions: [...delegation.actions],
    }];
  },
}));

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    // Login state is normally in memory here; expiry coverage reads the real persisted session.
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    resolveContext: async (globalOpts: unknown) => {
      recorded.resolveContexts.push(globalOpts);
      return {
        profile: "default",
        host: "https://tinycloud.test",
      };
    },
    getProfile: async () => currentProfile,
    getSession: async () => useStoredSession ? readSession("default") : currentSession,
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async (ctx: unknown, options: unknown) => {
    recorded.ensureAuthenticated.push({ ctx, options });
    return currentNode;
  },
}));

mock.module("@tinycloud/operations", () => ({
  invokeOperation: async (
    operationId: string,
    operationVersion: number,
    _target: unknown,
    input: { name: string; scope?: string; space?: string },
  ) => {
    expect(operationId).toBe("tinycloud.secrets.get");
    expect(operationVersion).toBe(1);
    if (canonicalResultOverride !== null) return canonicalResultOverride;
    const targetSpace = input.space ?? "secrets";
    const read = await currentNode.readSecret({
      space: targetSpace,
      name: input.name,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
    if (read.status === "ok") {
      return {
        status: "ok" as const,
        operation: { operationId, operationVersion },
        context: { profile: "default", host: "https://tinycloud.test", posture: "owner-openkey" as const },
        output: { value: read.value },
      };
    }
    if (read.status === "permission_required") {
      const networkId = currentNode.getEncryptionNetworkIdForSpace(targetSpace);
      return {
        status: "authority_required" as const,
        operation: { operationId, operationVersion },
        context: { profile: "default", host: "https://tinycloud.test", posture: currentProfile.posture },
        missing: [
          {
            service: "tinycloud.kv",
            space: targetSpace,
            path: `vault/secrets${input.scope ? `/scoped/${input.scope.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}` : ""}/${input.name}`,
            actions: ["tinycloud.kv/get"],
          },
          {
            service: "tinycloud.encryption",
            path: networkId,
            actions: ["tinycloud.encryption/decrypt"],
          },
        ],
        request: { requestId: "request-secret-get" },
        approval: { kind: "openkey" as const, requestId: "request-secret-get", fallback: "tc auth grant" },
        retry: { operationId, operationVersion, inputDigest: "digest", requiresCallerInput: false },
      };
    }
    if (read.status === "not_found") {
      return {
        status: "setup_required" as const,
        operation: { operationId, operationVersion },
        context: { profile: "default", host: "https://tinycloud.test", posture: currentProfile.posture },
        setup: { kind: "secret_manager", url: "https://secrets.tinycloud.xyz" },
        retry: { operationId, operationVersion, inputDigest: "digest", requiresCallerInput: true },
      };
    }
    return {
      status: "error" as const,
      operation: { operationId, operationVersion },
      context: { profile: "default", host: "https://tinycloud.test", posture: currentProfile.posture },
      error: { code: "SECRET_READ_FAILED" as const, message: "The secret ciphertext could not be read.", retryable: false },
    };
  },
}));

mock.module("./auth.js", () => ({
  refreshOpenKeySession: async (profile: string, host: string) => {
    recorded.sessionRefreshes.push({ profile, host });
    currentSession = { expiresAt: "2099-01-01T00:00:00.000Z" };
  },
  ensureDelegationAuthority: async (params: {
    ctx: { profile: string };
    requested: Array<{
      service: string;
      space?: string;
      path: string;
      actions: string[];
      skipPrefix?: boolean;
    }>;
  }) => {
    recorded.permissionRequests.push({
      profile: params.ctx.profile,
      requested: params.requested,
    });
  },
}));

mock.module("../output/formatter.js", () => ({
  formatCheck: (ok: boolean | "warn", label: string, detail?: string) =>
    `${String(ok)} ${label}${detail ? ` (${detail})` : ""}`,
  formatSection: (title: string) => title,
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  shouldOutputJson: () => outputJsonRequested,
  isInteractive: () => interactive,
  withSpinner: async (_message: string, fn: () => unknown) => {
    recorded.spinners.push(_message);
    return await fn();
  },
}));

mock.module("../output/theme.js", () => {
  const passthrough = (value: string) => value;
  return {
    theme: {
      hint: passthrough,
      success: passthrough,
      warn: passthrough,
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
}));

const { registerSecretsCommand } = await import("./secrets.js");

async function runSecretsCommand(args: string[]): Promise<void> {
  const program = new Command();
  program.option("--json", "Force JSON output");
  registerSecretsCommand(program);
  outputJsonRequested = args.includes("--json");
  await program.parseAsync(["node", "tc", ...args], { from: "node" });
}

beforeEach(() => {
  resetRecorded();
  outputJsonRequested = false;
  useStoredSession = false;
  interactive = true;
  currentNode = makeFakeNode();
  currentSession = {
    expiresAt: "2099-01-01T00:00:00.000Z",
    address: "0x0000000000000000000000000000000000000001",
    chainId: 1,
  };
  currentProfile = {
    name: "default",
    host: "https://tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:z6MkSession",
    createdAt: "2026-06-01T00:00:00.000Z",
    authMethod: "openkey",
    posture: "owner-openkey",
    operatorType: "human",
  };
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, get: () => interactive });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, get: () => interactive });
});
afterEach(() => {
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
  else Reflect.deleteProperty(process.stderr, "isTTY");
});

describe("CLI secrets commands", () => {
  test("preserves canonical auth, network, and Secret Manager compatibility mappings", async () => {
    canonicalResultOverride = {
      status: "error",
      operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
      context: { profile: "default", host: "https://tinycloud.test", posture: "unauthenticated" },
      error: { code: "PROFILE_POSTURE_NOT_ALLOWED", message: "Not authenticated.", retryable: false },
    };
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    const authError = recorded.errors.pop() as CLIErrorLike;
    expect(authError).toMatchObject({ code: "AUTH_REQUIRED", exitCode: 3 });
    expect(authError.metadata?.hint).toContain("auth login");

    canonicalResultOverride = {
      status: "error",
      operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
      context: { profile: "default", host: "https://tinycloud.test", posture: "owner-openkey" },
      error: { code: "NODE_UNREACHABLE", message: "The TinyCloud node could not be reached.", retryable: true },
    };
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    expect(recorded.errors.pop()).toMatchObject({ code: "NETWORK_ERROR", exitCode: 6 });

    const setup = {
      kind: "secret_manager",
      secret: { name: "ANTHROPIC_API_KEY", space: "secrets" },
      url: "https://secrets.tinycloud.xyz/setup?name=ANTHROPIC_API_KEY",
      message: "Enter this secret in Secret Manager, then retry the operation.",
    };
    canonicalResultOverride = {
      status: "setup_required",
      operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
      context: { profile: "default", host: "https://tinycloud.test", posture: "owner-openkey" },
      setup,
      retry: { operationId: "tinycloud.secrets.get", operationVersion: 1, inputDigest: "digest", requiresCallerInput: true },
    };
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    expect(recorded.errors.pop()).toMatchObject({ code: "NOT_FOUND", exitCode: 4, metadata: { setup } });
  });

  test("preserves the get help spelling and output aliases", () => {
    const program = new Command();
    registerSecretsCommand(program);
    const secrets = program.commands.find((command) => command.name() === "secrets");
    const get = secrets?.commands.find((command) => command.name() === "get");
    const help = get?.helpInformation() ?? "";

    expect(help).toContain("secrets get [options] <name>");
    expect(help).toContain("--raw");
    expect(help).toContain("--value-only");
    expect(help).toContain("-o, --output <file>");
    expect(help).toContain("--delegation <source>");
  });

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

  test("supports ordinary, raw, value-only, and explicit --json success output", async () => {
    await runSecretsCommand(["--json", "secrets", "get", "ANTHROPIC_API_KEY"]);
    expect(recorded.outputs).toEqual([{ name: "ANTHROPIC_API_KEY", value: "stored-value" }]);
    expect(outputJsonRequested).toBe(true);

    const writes: string[] = [];
    const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = stdout.write;
    stdout.write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--raw"]);
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--value-only"]);
    } finally {
      stdout.write = originalWrite;
    }

    expect(writes).toEqual(["stored-value", "stored-value"]);
  });

  test("rejects invalid secret names and scopes with usage errors", async () => {
    await runSecretsCommand(["secrets", "get", "not-a-secret"]);
    expect(recorded.errors[0]).toMatchObject({ code: "INVALID_SECRET_NAME", exitCode: 2 });

    resetRecorded();
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--scope", "default"]);
    expect(recorded.errors[0]).toMatchObject({ code: "INVALID_SECRET_SCOPE", exitCode: 2 });
  });

  test("emits the exact --json command error and usage exit code", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-secrets-cli-"));
    try {
      const profileDir = join(home, ".tinycloud", "profiles", "default");
      await mkdir(profileDir, { recursive: true });
      await writeFile(join(profileDir, "profile.json"), JSON.stringify({
        name: "default",
        host: "https://node.tinycloud.test",
        chainId: 1,
        spaceName: "default",
        did: "did:key:z6MkSession",
        createdAt: "2026-07-14T12:00:00.000Z",
        authMethod: "openkey",
        posture: "owner-openkey",
        operatorType: "human",
      }), "utf8");

      const child = Bun.spawn([
        process.execPath,
        join(process.cwd(), "packages/cli/test-support/secrets-json-error.ts"),
        "--quiet",
        "--json",
        "secrets",
        "get",
        "not-a-secret",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode, stderr).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe([
        "{",
        '  "error": {',
        '    "code": "INVALID_SECRET_NAME",',
        '    "message": "Invalid secret name \\"not-a-secret\\". Secret names must match ^[A-Z][A-Z0-9_]*$."',
        "  }",
        "}",
        "",
      ].join("\n"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("maps absent, owner permission, and delegated decrypt failures without treating failures as absence", async () => {
    currentNode = makeFakeNode({
      getResult: { ok: false, error: { code: "NOT_FOUND", message: "missing" } },
    });
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    expect(recorded.errors[0]).toMatchObject({ code: "NOT_FOUND", exitCode: 4 });

    resetRecorded();
    currentNode = makeFakeNode({
      getResult: { ok: false, error: { code: "PERMISSION_DENIED", message: "permission denied" } },
    });
    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);
    expect(recorded.errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(recorded.outputs).toEqual([]);

    resetRecorded();
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-decrypt-"));
    const source = join(dir, "delegation.json");
    await writeFile(source, JSON.stringify({
      delegation: {
        cid: "bafy-decrypt-failure",
        spaceId: "secrets",
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkDelegate",
        ownerAddress: "0xOwner",
        chainId: 1,
        expiry: "2099-01-01T00:00:00.000Z",
        delegationHeader: { Authorization: "Bearer delegated" },
      },
      permissions: [
        { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] },
        { service: "tinycloud.encryption", path: DEFAULT_NETWORK_ID, actions: ["tinycloud.encryption/decrypt"] },
      ],
    }), "utf8");
    currentNode = makeFakeNode({
      delegatedKvResult: {
        ok: true,
        data: { data: JSON.stringify({ networkId: DEFAULT_NETWORK_ID, ciphertext: SECRET_VALUE_CANARY }) },
      },
      decryptResult: { ok: false, error: { code: "DECRYPTION_FAILED", message: "ciphertext could not be decrypted" } },
    });
    try {
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--delegation", source]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(recorded.errors[0]).toMatchObject({ code: "DECRYPTION_FAILED", exitCode: 1 });
    expect(recorded.errors[0]).not.toMatchObject({ code: "NOT_FOUND" });
    expect([
      JSON.stringify(recorded.outputs),
      ...(recorded.errors.map((error) => error instanceof Error ? error.message : String(error))),
    ].join("\n")).not.toContain(SECRET_VALUE_CANARY);
  });

  test("maps delegated decrypt PERMISSION_DENIED without requesting owner authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-decrypt-permission-"));
    const source = join(dir, "delegation.json");
    await writeFile(source, JSON.stringify({
      delegation: {
        cid: "bafy-decrypt-permission",
        spaceId: "secrets",
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkDelegate",
        ownerAddress: "0xOwner",
        chainId: 1,
        expiry: "2099-01-01T00:00:00.000Z",
        delegationHeader: { Authorization: "Bearer delegated" },
      },
      permissions: [
        { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] },
        { service: "tinycloud.encryption", path: DEFAULT_NETWORK_ID, actions: ["tinycloud.encryption/decrypt"] },
      ],
    }), "utf8");
    currentNode = makeFakeNode({
      delegatedKvResult: { ok: true, data: { data: JSON.stringify({ networkId: DEFAULT_NETWORK_ID, ciphertext: SECRET_VALUE_CANARY }) } },
      decryptResult: { ok: false, error: { code: "PERMISSION_DENIED", message: "decrypt capability denied" } },
    });
    try {
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--delegation", source]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(recorded.errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(recorded.permissionRequests).toEqual([]);
    expect([
      JSON.stringify(recorded.outputs),
      ...(recorded.errors.map((error) => error instanceof Error ? error.message : String(error))),
    ].join("\n")).not.toContain(SECRET_VALUE_CANARY);
  });

  test("preserves the shipped generic exit code for delegated transport results without retrying", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-transport-"));
    const source = join(dir, "delegation.json");
    await writeFile(source, JSON.stringify({
      delegation: {
        cid: "bafy-transport-failure",
        spaceId: "secrets",
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkDelegate",
        ownerAddress: "0xOwner",
        chainId: 1,
        expiry: "2099-01-01T00:00:00.000Z",
        delegationHeader: { Authorization: "Bearer delegated" },
      },
      permissions: [
        { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ANTHROPIC_API_KEY", actions: ["tinycloud.kv/get"] },
        { service: "tinycloud.encryption", path: DEFAULT_NETWORK_ID, actions: ["tinycloud.encryption/decrypt"] },
      ],
    }), "utf8");
    currentNode = makeFakeNode({
      delegatedKvResult: { ok: false, error: { code: "TRANSPORT_ERROR", message: "connection dropped while reading envelope" } },
    });
    try {
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--delegation", source]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(recorded.errors[0]).toMatchObject({ code: "TRANSPORT_ERROR", exitCode: 1 });
    expect(recorded.delegatedKvGets).toHaveLength(1);
    expect(recorded.permissionRequests).toEqual([]);
  });

  test("does not fall back to owner acquisition for delegate-session secrets get", async () => {
    currentProfile = { ...currentProfile, posture: "delegate-session" };
    currentNode = makeFakeNode({
      getResult: {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "permission denied while reading secret" },
      },
    });

    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);

    expect(recorded.getCalls).toEqual([{ name: "ANTHROPIC_API_KEY", options: undefined }]);
    expect(recorded.permissionRequests).toEqual([]);
    expect(recorded.errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
  });

  test("routes --space operations and permission requests to the requested TinyCloud space", async () => {
    const targetSpace = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:other";
    const targetNetwork = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
    currentNode = makeFakeNode({
      getResult: [
        {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            service: "secrets",
            message: "Cannot autosign tinycloud.kv/get for ANTHROPIC_API_KEY",
          },
        },
        { ok: true, data: "stored-value" },
      ],
    });

    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "--space", "other"]);

    expect(recorded.secretsForSpaceCalls).toEqual([targetSpace, targetSpace]);
    expect(recorded.getCalls).toEqual([
      { name: "ANTHROPIC_API_KEY", options: undefined },
      { name: "ANTHROPIC_API_KEY", options: undefined },
    ]);
    expect(recorded.permissionRequests).toEqual([
      {
        profile: "default",
        requested: [
          {
            service: "tinycloud.kv",
            space: targetSpace,
            path: "vault/secrets/ANTHROPIC_API_KEY",
            actions: ["tinycloud.kv/get"],
          },
          {
            service: "tinycloud.encryption",
            path: targetNetwork,
            actions: ["tinycloud.encryption/decrypt"],
          },
        ],
      },
    ]);
    expect(recorded.outputs).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "stored-value" },
    ]);
  });

  test("delegated get honors --space when selecting delegation resources", async () => {
    const targetSpace = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:other";
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-"));
    const source = join(dir, "delegation.json");

    await writeFile(source, JSON.stringify({
      delegation: {
        cid: "bafy-delegated-other",
        spaceId: targetSpace,
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkDelegate",
        ownerAddress: "0x0000000000000000000000000000000000000001",
        chainId: 1,
        expiry: "2099-01-01T00:00:00.000Z",
        delegationHeader: { Authorization: "Bearer delegated" },
      },
      permissions: [
        {
          service: "tinycloud.kv",
          space: targetSpace,
          path: "vault/secrets/ANTHROPIC_API_KEY",
          actions: ["tinycloud.kv/get"],
        },
        {
          service: "tinycloud.encryption",
          path: DEFAULT_NETWORK_ID,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ],
    }));

    try {
      await runSecretsCommand([
        "secrets",
        "get",
        "ANTHROPIC_API_KEY",
        "--space",
        "other",
        "--delegation",
        source,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(recorded.delegatedKvGets).toEqual([
      {
        path: "vault/secrets/ANTHROPIC_API_KEY",
        options: { raw: true, prefix: "" },
      },
    ]);
    expect(recorded.decryptEnvelopeCalls).toEqual([
      {
        envelope: { networkId: DEFAULT_NETWORK_ID },
        options: { proofs: ["bafy-delegated-other"] },
      },
    ]);
    expect(recorded.outputs).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "delegated-value" },
    ]);
  });

  test("refreshes an expired owner OpenKey session before listing secrets", async () => {
    currentSession = {
      siwe: [
        "tinycloud.test wants you to sign in",
        "Expiration Time: 2026-06-02T17:30:53.120Z",
      ].join("\n"),
    };

    await runSecretsCommand(["secrets", "list"]);

    expect(recorded.sessionRefreshes).toEqual([
      { profile: "default", host: "https://tinycloud.test" },
    ]);
    expect(recorded.ensureAuthenticated).toHaveLength(1);
    expect(recorded.listCalls).toEqual([undefined]);
    expect(recorded.outputs).toEqual([
      { secrets: ["ANTHROPIC_API_KEY"], count: 1 },
    ]);
    expect(recorded.spinners).toEqual([
      "Refreshing TinyCloud session...",
      "Listing secrets...",
    ]);
  });

  test("refreshes an expired owner OpenKey session with numeric seconds expiry", async () => {
    currentSession = {
      expirationTime: 1,
    };

    await runSecretsCommand(["secrets", "list"]);

    expect(recorded.sessionRefreshes).toEqual([
      { profile: "default", host: "https://tinycloud.test" },
    ]);
    expect(recorded.listCalls).toEqual([undefined]);
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

  test("doctor reports an existing encryption network and readable secret", async () => {
    const descriptor = makeDescriptor();
    currentNode = makeFakeNode({ networkShowResult: descriptor });

    await runSecretsCommand(["--json", "secrets", "doctor", "ANTHROPIC_API_KEY", "--scope", "Food Tracker"]);

    expect(recorded.networkShowCalls).toEqual(["default"]);
    expect(recorded.getCalls).toEqual([
      { name: "ANTHROPIC_API_KEY", options: { scope: "Food Tracker" } },
    ]);
    expect(recorded.outputs).toEqual([
      {
        healthy: true,
        network: {
          name: "default",
          networkId: DEFAULT_NETWORK_ID,
          exists: true,
          state: "active",
        },
        secret: {
          name: "ANTHROPIC_API_KEY",
          path: "vault/secrets/scoped/food-tracker/ANTHROPIC_API_KEY",
          scope: "food-tracker",
          exists: true,
          readable: true,
        },
        checks: [
          {
            name: "Encryption network",
            ok: true,
            detail: "default (active)",
          },
          {
            name: "Secret access",
            ok: true,
            detail: "vault/secrets/scoped/food-tracker/ANTHROPIC_API_KEY readable",
          },
        ],
      },
    ]);
  });

  test("doctor reports a missing network without initializing it", async () => {
    currentNode = makeFakeNode({ networkShowResult: null });

    await runSecretsCommand(["--json", "secrets", "doctor"]);

    expect(recorded.networkShowCalls).toEqual(["default"]);
    expect(recorded.networkInitCalls).toEqual([]);
    expect(recorded.getCalls).toEqual([]);
    expect(recorded.outputs).toEqual([
      {
        healthy: false,
        network: {
          name: "default",
          networkId: DEFAULT_NETWORK_ID,
          exists: false,
        },
        checks: [
          {
            name: "Encryption network",
            ok: false,
            detail: "default not found",
            hint: "tc secrets network init default",
          },
          {
            name: "Secret access",
            ok: "warn",
            detail: "skipped; pass a secret name to verify read access",
          },
        ],
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

  test("requests list permission and retries when an owner session is expired", async () => {
    currentNode = makeFakeNode({
      listResult: [
        {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            service: "secrets",
            message: "Session expired at 2026-06-02T17:30:53.120Z",
          },
        },
        { ok: true, data: ["ANTHROPIC_API_KEY"] },
      ],
    });

    await runSecretsCommand(["secrets", "list"]);

    expect(recorded.listCalls).toEqual([undefined, undefined]);
    expect(recorded.permissionRequests).toEqual([
      {
        profile: "default",
        requested: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/",
            actions: ["tinycloud.kv/list"],
            skipPrefix: true,
          },
        ],
      },
    ]);
    expect(recorded.outputs).toEqual([
      { secrets: ["ANTHROPIC_API_KEY"], count: 1 },
    ]);
  });

  test("requests list permission and retries when the SDK throws a permission error", async () => {
    currentNode = makeFakeNode({
      listError: [
        Object.assign(
          new Error("grantRuntimePermissions requires wallet mode with a signer or privateKey."),
          { code: "PERMISSION_DENIED" },
        ),
      ],
    });

    await runSecretsCommand(["secrets", "list"]);

    expect(recorded.permissionRequests).toEqual([
      {
        profile: "default",
        requested: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/",
            actions: ["tinycloud.kv/list"],
            skipPrefix: true,
          },
        ],
      },
    ]);
    expect(recorded.listCalls).toEqual([undefined, undefined]);
    expect(recorded.outputs).toEqual([
      { secrets: ["ANTHROPIC_API_KEY"], count: 1 },
    ]);
  });

  test("requests secret read and decrypt permissions before retrying get", async () => {
    currentNode = makeFakeNode({
      getResult: [
        {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            service: "secrets",
            message: "Cannot autosign tinycloud.kv/get for ANTHROPIC_API_KEY",
          },
        },
        { ok: true, data: "stored-value" },
      ],
    });

    await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY"]);

    expect(recorded.getCalls).toEqual([
      { name: "ANTHROPIC_API_KEY", options: undefined },
      { name: "ANTHROPIC_API_KEY", options: undefined },
    ]);
    expect(recorded.permissionRequests).toEqual([
      {
        profile: "default",
        requested: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/ANTHROPIC_API_KEY",
            actions: ["tinycloud.kv/get"],
          },
          {
            service: "tinycloud.encryption",
            path: DEFAULT_NETWORK_ID,
            actions: ["tinycloud.encryption/decrypt"],
          },
        ],
      },
    ]);
    expect(recorded.outputs).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "stored-value" },
    ]);
  });

  test("does not request owner permissions for delegate-session profiles", async () => {
    currentProfile = {
      ...currentProfile,
      posture: "delegate-session",
    };
    currentNode = makeFakeNode({
      listResult: {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          service: "secrets",
          message: "Permission denied while listing secrets",
        },
      },
    });

    await runSecretsCommand(["secrets", "list"]);

    expect(recorded.permissionRequests).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    const error = recorded.errors[0] as CLIErrorLike;
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toBe("Permission denied while listing secrets");
  });

  test("surfaces permission errors after a retry without exposing secret values", async () => {
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
    expect(recorded.outputs).toEqual([]);
    expect(recorded.getCalls).toHaveLength(2);
    expect(recorded.permissionRequests).toHaveLength(1);
  });

  test("writes `get -o` output owner-only, also over an existing world-readable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-output-"));
    try {
      const created = join(dir, "created.txt");
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "-o", created]);
      const existing = join(dir, "existing.txt");
      await writeFile(existing, "old", { mode: 0o644 });
      await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "-o", existing]);

      expect(recorded.errors).toEqual([]);
      for (const path of [created, existing]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await Bun.file(path).text()).toBe("stored-value");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncs secret output and its parent directory on either side of the atomic rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-sync-"));
    const destination = join(dir, "key");
    const probe = await open(join(dir, "probe"), "wx");
    const originalSync = probe.sync;
    const stages: string[] = [];
    const sync = spyOn(Object.getPrototypeOf(probe), "sync").mockImplementation(async function (this: typeof probe) {
      const stage = (await this.stat()).isDirectory() ? "directory" : "file";
      stages.push(stage);
      expect(await readFile(destination, "utf8")).toBe(stage === "file" ? "old-value" : "stored-value");
      await originalSync.call(this);
    });
    try {
      await probe.close();
      await writeFile(destination, "old-value");
      await runSecretsCommand(["secrets", "get", "KEY", "-o", destination]);
      expect(recorded.errors).toEqual([]);
      expect(stages).toEqual(["file", "directory"]);
      expect(await readFile(destination, "utf8")).toBe("stored-value");
    } finally {
      sync.mockRestore();
      await probe.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a successfully replaced secret when directory sync is unsupported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-dir-sync-"));
    const destination = join(dir, "key");
    const probe = await open(join(dir, "probe"), "wx");
    const originalSync = probe.sync;
    const sync = spyOn(Object.getPrototypeOf(probe), "sync").mockImplementation(async function (this: typeof probe) {
      if ((await this.stat()).isDirectory()) {
        throw Object.assign(new Error("directory sync unsupported"), { code: "ENOTSUP" });
      }
      await originalSync.call(this);
    });
    try {
      await probe.close();
      await runSecretsCommand(["secrets", "get", "KEY", "-o", destination]);
      expect(recorded.errors).toEqual([]);
      expect(await readFile(destination, "utf8")).toBe("stored-value");
    } finally {
      sync.mockRestore();
      await probe.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports only the destination and cleans up temporary secret bytes when rename is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-rename-"));
    const destination = join(dir, "key");
    const probe = await open(join(dir, "probe"), "wx");
    const originalSync = probe.sync;
    const sync = spyOn(Object.getPrototypeOf(probe), "sync").mockImplementation(async function (this: typeof probe) {
      await originalSync.call(this);
      if ((await this.stat()).isFile()) {
        await mkdir(destination);
        await writeFile(join(destination, "owner-data"), "unchanged");
      }
    });
    try {
      await probe.close();
      await rm(join(dir, "probe"));
      await runSecretsCommand(["secrets", "get", "KEY", "-o", destination]);
      expect(recorded.errors).toHaveLength(1);
      const error = recorded.errors[0] as CLIErrorLike;
      expect(error.message).toContain(destination);
      expect(error.message).not.toContain(".tmp");
      expect(await readFile(join(destination, "owner-data"), "utf8")).toBe("unchanged");
      expect(await readdir(dir)).toEqual(["key"]);
      expect(recorded.outputs).toEqual([]);
    } finally {
      sync.mockRestore();
      await probe.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("atomically replaces an output inode without exposing secret bytes to existing readers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-atomic-"));
    try {
      const destination = join(dir, "key");
      const oldReader = join(dir, "old-reader");
      await writeFile(destination, "old-public-value", { mode: 0o644 });
      await link(destination, oldReader);
      const original = await open(destination, "r");
      try {
        await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "-o", destination]);
        expect(recorded.errors).toEqual([]);
        expect(await original.readFile({ encoding: "utf8" })).toBe("old-public-value");
        expect(await readFile(oldReader, "utf8")).toBe("old-public-value");
        expect(await readFile(destination, "utf8")).toBe("stored-value");
        expect((await stat(destination)).mode & 0o777).toBe(0o600);
      } finally {
        await original.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsafe output before canonical read or delegated decrypt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-predecrypt-"));
    try {
      const destination = join(dir, "unsafe");
      await symlink(join(dir, "target"), destination);
      await runSecretsCommand(["secrets", "get", "KEY", "-o", destination]);
      expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_ARGUMENT" })]);
      expect(recorded.getCalls).toEqual([]);

      const source = join(dir, "delegation.json");
      await writeFile(source, JSON.stringify({
        delegation: {
          cid: "bafy-delegated-output", spaceId: "secrets", path: "vault/secrets/KEY",
          actions: ["tinycloud.kv/get"], delegateDID: "did:key:z6MkDelegate",
          ownerAddress: "0x0000000000000000000000000000000000000001", chainId: 1,
          expiry: "2099-01-01T00:00:00.000Z",
          delegationHeader: { Authorization: "Bearer delegated" },
        },
        permissions: [
          { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] },
          { service: "tinycloud.encryption", path: DEFAULT_NETWORK_ID, actions: ["tinycloud.encryption/decrypt"] },
        ],
      }));
      resetRecorded();
      await runSecretsCommand(["secrets", "get", "KEY", "--delegation", source, "-o", destination]);
      expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_ARGUMENT" })]);
      expect(recorded.delegatedKvGets).toEqual([]);
      expect(recorded.decryptEnvelopeCalls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects directory and absent parent outputs without leaking temporary paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-output-parent-"));
    try {
      for (const destination of [dir, join(dir, "missing", "secret")]) {
        resetRecorded();
        await runSecretsCommand(["secrets", "get", "KEY", "-o", destination]);
        expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_ARGUMENT" })]);
        expect((recorded.errors[0] as Error).message).toContain(destination);
        expect((recorded.errors[0] as Error).message).not.toContain(".tmp");
        expect(recorded.getCalls).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses symlink and device outputs without changing their target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-secrets-unsafe-output-"));
    try {
      const target = join(dir, "target");
      const shortcut = join(dir, "shortcut");
      await writeFile(target, "public", { mode: 0o644 });
      await symlink(target, shortcut);
      for (const destination of [shortcut, "/dev/null", "/dev/stdout"]) {
        resetRecorded();
        await runSecretsCommand(["secrets", "get", "ANTHROPIC_API_KEY", "-o", destination]);
        expect(recorded.errors).toEqual([expect.objectContaining({ code: "INVALID_ARGUMENT" })]);
      }
      expect(await readFile(target, "utf8")).toBe("public");
      expect((await stat(target)).mode & 0o777).toBe(0o644);
      expect((await lstat(shortcut)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing or real stored signed expired OpenKey session fails headlessly before canonical invocation", async () => {
    interactive = false;
    const expired = await expiredSignedSession();
    expect(expired.signature).toMatch(/^0x[0-9a-f]+$/i);
    const home = await mkdtemp(join(tmpdir(), "tc-secrets-session-"));
    try {
      await withTinyCloudStateRoot(home, async () => {
        useStoredSession = true;
        for (const session of [null, expired]) {
          if (session) await writeSession("default", session);
          for (const args of [
            ["secrets", "list"],
            ["secrets", "put", "KEY", "value"],
            ["secrets", "delete", "KEY"],
            ["secrets", "get", "KEY", "--raw"],
          ]) {
            resetRecorded();
            await runSecretsCommand(args);
            expect(recorded.sessionRefreshes).toEqual([]);
            expect(recorded.getCalls).toEqual([]);
            expect(recorded.errors).toEqual([expect.objectContaining({
              code: "AUTH_REQUIRED",
              exitCode: 3,
              metadata: { hint: expect.stringContaining("auth login --method openkey --paste --manifest") },
            })]);
          }
        }
      });
    } finally {
      useStoredSession = false;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("interactive canonical get refreshes an expired signed OpenKey session", async () => {
    currentSession = await expiredSignedSession();
    await runSecretsCommand(["secrets", "get", "KEY"]);
    expect(recorded.sessionRefreshes).toEqual([{ profile: "default", host: "https://tinycloud.test" }]);
    expect(recorded.getCalls).toHaveLength(1);
    expect(recorded.outputs).toEqual([{ name: "KEY", value: "stored-value" }]);
  });

  test("canonical node failures remain node failures, not expired-session authentication errors", async () => {
    interactive = false;
    canonicalResultOverride = {
      status: "error",
      operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
      context: { profile: "default", host: "https://tinycloud.test", posture: "owner-openkey" },
      error: { code: "NODE_ERROR", message: "Unexpected node response", retryable: false },
    };
    await runSecretsCommand(["secrets", "get", "KEY"]);
    expect(recorded.errors).toEqual([expect.objectContaining({ code: "NODE_ERROR", exitCode: 1 })]);
  });

  test("a non-interactive OpenKey profile without the grant fails fast instead of opening a browser approval", async () => {
    interactive = false;
    const denied = { ok: false as const, error: { code: "PERMISSION_DENIED", service: "secrets", message: "Cannot autosign tinycloud.kv/get for OTHER_KEY" } };
    currentNode = makeFakeNode({ getResult: denied, listResult: denied, putResult: denied, deleteResult: denied });

    for (const args of [
      ["secrets", "get", "OTHER_KEY", "--raw"],
      ["secrets", "list"],
      ["secrets", "put", "OTHER_KEY", "value"],
      ["secrets", "delete", "OTHER_KEY"],
    ]) {
      resetRecorded();
      await runSecretsCommand(args);
      expect(recorded.permissionRequests).toEqual([]);
      expect(recorded.sessionRefreshes).toEqual([]);
      expect(recorded.errors).toEqual([expect.objectContaining({
        code: "PERMISSION_DENIED",
        exitCode: 5,
        metadata: { hint: expect.stringContaining("auth login --method openkey --paste --manifest") },
      })]);
    }
  });
  test("names decrypt only when it is the sole missing headless read capability", async () => {
    interactive = false;
    const denied = { ok: false as const, error: { code: "PERMISSION_DENIED", service: "secrets", message: "Cannot autosign tinycloud.kv/get for KEY" } };
    currentNode = makeFakeNode({ getResult: denied, listResult: denied });

    await runSecretsCommand(["secrets", "get", "KEY", "--scope", "team", "--raw"]);
    const getError = recorded.errors[0] as CLIErrorLike;
    expect(getError).toMatchObject({
      code: "PERMISSION_DENIED",
      exitCode: 5,
      metadata: { hint: expect.stringContaining("auth login --method openkey --paste --manifest") },
    });
    expect(getError.message).toContain("read or decrypt grant");
    expect(getError.message).toContain('secret "KEY"');
    expect(getError.message).not.toContain("holds no grant");
    expect(getError.message).not.toContain("lacks the scoped decrypt authority");

    resetRecorded();
    canonicalResultOverride = {
      status: "authority_required",
      context: { posture: "owner-openkey" },
      missing: [{ actions: ["tinycloud.kv/get"] }],
    };
    await runSecretsCommand(["secrets", "get", "KEY", "--raw"]);
    expect((recorded.errors[0] as CLIErrorLike).message).toContain("read or decrypt grant");
    expect((recorded.errors[0] as CLIErrorLike).message).not.toContain("lacks the scoped decrypt authority");

    resetRecorded();
    canonicalResultOverride = {
      status: "authority_required",
      context: { posture: "owner-openkey" },
      missing: [{ service: "tinycloud.encryption", actions: ["tinycloud.encryption/decrypt"] }],
    };
    await runSecretsCommand(["secrets", "get", "KEY", "--raw"]);
    expect((recorded.errors[0] as CLIErrorLike).message).toContain("lacks the scoped decrypt authority (tinycloud.encryption/decrypt)");
    expect((recorded.errors[0] as CLIErrorLike).message).not.toContain("read or decrypt grant");

    resetRecorded();
    await runSecretsCommand(["secrets", "list"]);
    expect((recorded.errors[0] as CLIErrorLike).message).toContain("holds no grant");
  });

  test("requests scoped put permission at secrets/scoped/<scope>/<name>", async () => {
    currentNode = makeFakeNode({
      putResult: [
        {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            service: "secrets",
            message: "Cannot autosign tinycloud.kv/put for ANTHROPIC_API_KEY",
          },
        },
        { ok: true, data: undefined },
      ],
    });

    await runSecretsCommand([
      "secrets",
      "put",
      "ANTHROPIC_API_KEY",
      "super-secret",
      "--scope",
      "Food Tracker",
    ]);

    expect(recorded.permissionRequests).toEqual([
      {
        profile: "default",
        requested: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/scoped/food-tracker/ANTHROPIC_API_KEY",
            actions: ["tinycloud.kv/put"],
            skipPrefix: true,
          },
        ],
      },
    ]);
  });

  test("--space routes operations and permission requests to the requested space", async () => {
    const targetSpace = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:custom-vault";
    currentNode = makeFakeNode({
      listError: [
        Object.assign(
          new Error("grantRuntimePermissions requires wallet mode with a signer or privateKey."),
          { code: "PERMISSION_DENIED" },
        ),
      ],
    });

    await runSecretsCommand(["secrets", "list", "--space", "custom-vault"]);

    expect(recorded.permissionRequests).toEqual([
      {
        profile: "default",
        requested: [
          {
            service: "tinycloud.kv",
            space: targetSpace,
            path: "vault/secrets/",
            actions: ["tinycloud.kv/list"],
            skipPrefix: true,
          },
        ],
      },
    ]);
  });

  test("--space is no longer aliased to --scope", async () => {
    await runSecretsCommand(["secrets", "list", "--space", "custom-vault"]);

    // --space must not silently feed into --scope.
    expect(recorded.listCalls).toEqual([undefined]);
    expect(recorded.outputs).toEqual([
      {
        secrets: ["ANTHROPIC_API_KEY"],
        count: 1,
        space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:custom-vault",
      },
    ]);
  });

  test(
    "tc secrets get pins the permission grant to the 'secrets' space even when the profile defaults to 'default'",
    async () => {
      // Profile defaults to spaceName "default", but the secret-manager web
      // app stores secrets in the literal "secrets" space. The CLI must
      // override the profile's default space when requesting permissions so
      // CLI-issued grants line up with web-app-written secrets at
      // vault/secrets/ASSEMBLYAI_API_KEY in space "secrets".
      currentProfile = { ...currentProfile, spaceName: "default" };
      currentNode = makeFakeNode({
        getResult: [
          {
            ok: false,
            error: {
              code: "PERMISSION_DENIED",
              service: "secrets",
              message: "Cannot autosign tinycloud.kv/get for ASSEMBLYAI_API_KEY",
            },
          },
          { ok: true, data: "secret-value-from-web-app" },
        ],
      });

      await runSecretsCommand(["secrets", "get", "ASSEMBLYAI_API_KEY"]);

      expect(recorded.permissionRequests).toEqual([
        {
          profile: "default",
          requested: [
            {
              service: "tinycloud.kv",
              space: "secrets",
              path: "vault/secrets/ASSEMBLYAI_API_KEY",
              actions: ["tinycloud.kv/get"],
            },
            {
              service: "tinycloud.encryption",
              path: DEFAULT_NETWORK_ID,
              actions: ["tinycloud.encryption/decrypt"],
            },
          ],
        },
      ]);
      expect(recorded.outputs).toEqual([
        { name: "ASSEMBLYAI_API_KEY", value: "secret-value-from-web-app" },
      ]);
    },
  );
});
