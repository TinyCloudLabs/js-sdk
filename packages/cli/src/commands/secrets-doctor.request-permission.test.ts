import { beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { ISecretsService, PermissionEntry } from "@tinycloud/node-sdk";
import type * as NodeSecretsModule from "../../../node-sdk/src/NodeSecretsService";

// NodeSecretsService is internal to node-sdk; load it from source as the one-approval tests do.
const { NodeSecretsService } = await import(new URL("../../../node-sdk/src/NodeSecretsService.ts", import.meta.url).href) as
  typeof NodeSecretsModule;

// TC-3801 F2: a secrets read asks for missing authority only when the caller
// passes `requestPermission`. `secrets doctor NAME` is user-started, so it must
// still ask, as it did before F2.

const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf:default";

let outputs: unknown[] = [];
let errors: unknown[] = [];
let granted: PermissionEntry[][] = [];
let covered = false;

const innerSecrets = {
  get: async () => ({ ok: true as const, data: "stored-value" }),
} as unknown as ISecretsService;

function localOwnerNode() {
  const secrets = new NodeSecretsService({
    getService: () => innerSecrets,
    getManifest: () => undefined,
    // A local owner key can sign, so a read that may ask escalates without a browser.
    canEscalate: () => true,
    uncoveredEntries: (entries) => (covered ? [] : entries),
    grantPermissions: async (entries) => {
      granted.push(entries);
      covered = true;
    },
    getEncryptionNetworkId: () => NETWORK_ID,
  });
  return {
    secrets,
    getDefaultEncryptionNetworkId: () => NETWORK_ID,
    getEncryptionNetwork: async () => ({ networkId: NETWORK_ID, state: "active" }),
  };
}

let currentNode = localOwnerNode();

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    resolveContext: async () => ({ profile: "default", host: "https://tinycloud.test" }),
    getProfile: async () => ({ name: "default", host: "https://tinycloud.test", chainId: 1, spaceName: "default", authMethod: "local" }),
    getSession: async () => null,
  },
}));

const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({
  ...realSdk,
  ensureAuthenticated: async () => currentNode,
}));

const realFormatter = await import("../output/formatter.js");
mock.module("../output/formatter.js", () => ({
  ...realFormatter,
  outputJson: (payload: unknown) => {
    outputs.push(payload);
  },
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
}));

const realErrors = await import("../output/errors.js");
mock.module("../output/errors.js", () => ({
  ...realErrors,
  handleError: (error: unknown) => {
    errors.push(error);
  },
}));

const { registerSecretsCommand } = await import("./secrets.js");

async function runDoctor(name: string): Promise<void> {
  const program = new Command();
  program.option("--json", "Force JSON output");
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", "--json", "secrets", "doctor", name], { from: "node" });
}

beforeEach(() => {
  outputs = [];
  errors = [];
  granted = [];
  covered = false;
  currentNode = localOwnerNode();
});

test("doctor NAME asks once for the secret's own key and reports the secret readable", async () => {
  await runDoctor("ANTHROPIC_API_KEY");

  expect(errors).toEqual([]);
  expect(granted).toHaveLength(1);
  expect(granted[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({
      service: "tinycloud.encryption",
      path: `${NETWORK_ID}/secrets/anthropic_api_key`,
      actions: ["decrypt"],
    }),
  ]));
  expect(outputs).toEqual([
    expect.objectContaining({
      healthy: true,
      secret: expect.objectContaining({ name: "ANTHROPIC_API_KEY", exists: true, readable: true }),
    }),
  ]);
});

test("doctor NAME does not ask when the read is already covered", async () => {
  covered = true;

  await runDoctor("ANTHROPIC_API_KEY");

  expect(errors).toEqual([]);
  expect(granted).toEqual([]);
  expect(outputs).toEqual([
    expect.objectContaining({ secret: expect.objectContaining({ readable: true }) }),
  ]);
});
