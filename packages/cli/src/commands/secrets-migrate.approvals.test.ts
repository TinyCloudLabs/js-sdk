import { beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { PermissionEntry } from "@tinycloud/node-sdk";

// TC-3284/TC-4246: an owner `secrets migrate` lists with read access first, then asks one approval: write, the
// network root and exactly the moved secrets' own keys. A dry run asks only to list and read. No approval names a
// `secrets/` prefix.

const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:default";
const COMBINED = "Create a key for each of your older-format secrets and move the secret onto it. This needs access to all your encrypted data, because only that access can read the older format.";

let approvals: { requested: PermissionEntry[]; reason: string }[] = [];
let outputs: unknown[] = [];
let errors: unknown[] = [];

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    resolveContext: async () => ({ profile: "default", host: "https://tinycloud.test" }),
    getProfile: async () => ({
      name: "default", host: "https://tinycloud.test", chainId: 1, spaceName: "default",
      authMethod: "local", posture: "local-owner-key",
    }),
    getSession: async () => null,
  },
}));

const node = { getEncryptionNetworkIdForSpace: () => NETWORK_ID, secrets: {} };
const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({ ...realSdk, ensureAuthenticated: async () => node }));

const realAuth = await import("./auth.js");
mock.module("./auth.js", () => ({
  ...realAuth,
  ensureDelegationAuthority: async (params: { requested: PermissionEntry[]; reason: string }) => {
    approvals.push({ requested: params.requested, reason: params.reason });
  },
}));

// The real migrateSecrets is covered in sdk-services; here it selects two secrets and asks for their keys. The CLI
// imports it from its own subpath, which the web-sdk root bundle does not carry.
mock.module("@tinycloud/sdk-services/secrets/migrate", () => ({
  migrateSecrets: async (_secrets: unknown, options: { dryRun?: boolean; authorizeKeys?: (keyPaths: readonly string[]) => Promise<void> }) => {
    if (!options.dryRun) await options.authorizeKeys?.(["secrets/openai_api_key", "secrets/scoped/my-app/other_key"]);
    return { ok: true, data: { dryRun: options.dryRun === true, total: 2, moved: options.dryRun ? 0 : 2, already: 0, staysOnNetwork: 0, skipped: {} } };
  },
}));

const realFormatter = await import("../output/formatter.js");
mock.module("../output/formatter.js", () => ({
  ...realFormatter,
  outputJson: (payload: unknown) => { outputs.push(payload); },
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
}));

const realErrors = await import("../output/errors.js");
mock.module("../output/errors.js", () => ({ ...realErrors, handleError: (error: unknown) => { errors.push(error); } }));

const { registerSecretsCommand } = await import("./secrets.js");

async function migrate(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>").option("--json");
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", "secrets", "migrate", ...args], { from: "node" });
}

const encryptionPaths = (requested: PermissionEntry[]) =>
  requested.filter((entry) => entry.service === "tinycloud.encryption").map((entry) => entry.path);

beforeEach(() => {
  approvals = [];
  outputs = [];
  errors = [];
});

test("migrate lists with read access, then asks one approval: write, network root and exactly the moved secrets' keys", async () => {
  await migrate();

  expect(errors).toEqual([]);
  expect(approvals).toHaveLength(2);
  expect(approvals[0]!.requested.find((entry) => entry.service === "tinycloud.kv")!.actions)
    .toEqual(["tinycloud.kv/list", "tinycloud.kv/get"]);
  expect(encryptionPaths(approvals[0]!.requested)).toEqual([]);
  expect(approvals[1]!.reason).toBe(COMBINED);
  expect(approvals[1]!.requested).toEqual([
    {
      service: "tinycloud.kv", space: "secrets", path: "vault/secrets/", skipPrefix: true,
      actions: ["tinycloud.kv/list", "tinycloud.kv/get", "tinycloud.kv/put"],
    },
    { service: "tinycloud.encryption", path: NETWORK_ID, skipPrefix: true, actions: ["tinycloud.encryption/decrypt"] },
    ...[
      `${NETWORK_ID}/secrets/openai_api_key`,
      `${NETWORK_ID}/secrets/scoped/my-app/other_key`,
    ].map((path) => ({
      service: "tinycloud.encryption", path, skipPrefix: true,
      actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
    })),
  ]);
  expect(outputs).toEqual([expect.objectContaining({ moved: 2 })]);
});

test("a dry run asks only to list and read, with no encryption access", async () => {
  await migrate("--dry-run");

  expect(errors).toEqual([]);
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.requested).toHaveLength(1);
  expect(approvals[0]!.requested[0]!.actions).toEqual(["tinycloud.kv/list", "tinycloud.kv/get"]);
});
