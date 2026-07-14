import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const DEFAULT_NETWORK_ID =
  "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const DEFAULT_NODE_DID = "did:key:z6MkPrincipal";
const SECRET_VALUE_CANARY = "tc-191-secret-value-canary";

type CLIErrorLike = {
  code: string;
  message: string;
  exitCode: number;
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

let currentNode: FakeNode;
let outputJsonRequested = false;
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
    resolveContext: async (globalOpts: unknown) => {
      recorded.resolveContexts.push(globalOpts);
      return {
        profile: "default",
        host: "https://tinycloud.test",
      };
    },
    getProfile: async () => currentProfile,
    getSession: async () => currentSession,
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async (ctx: unknown, options: unknown) => {
    recorded.ensureAuthenticated.push({ ctx, options });
    return currentNode;
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
  program.option("--json", "Force JSON output");
  registerSecretsCommand(program);
  outputJsonRequested = args.includes("--json");
  await program.parseAsync(["node", "tc", ...args], { from: "node" });
}

beforeEach(() => {
  resetRecorded();
  outputJsonRequested = false;
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
});

describe("CLI secrets commands", () => {
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
    expect(recorded.errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 1 });
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
    expect(recorded.errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 1 });
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

    expect(recorded.secretsForSpaceCalls).toEqual([targetSpace]);
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
            skipPrefix: true,
          },
          {
            service: "tinycloud.encryption",
            path: targetNetwork,
            actions: ["tinycloud.encryption/decrypt"],
            skipPrefix: true,
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
            skipPrefix: true,
          },
          {
            service: "tinycloud.encryption",
            path: DEFAULT_NETWORK_ID,
            actions: ["tinycloud.encryption/decrypt"],
            skipPrefix: true,
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
              skipPrefix: true,
            },
            {
              service: "tinycloud.encryption",
              path: DEFAULT_NETWORK_ID,
              actions: ["tinycloud.encryption/decrypt"],
              skipPrefix: true,
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
