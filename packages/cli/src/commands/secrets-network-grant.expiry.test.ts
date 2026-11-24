import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { SECRET_KEY_GRANT_DEFAULT_MS, SECRET_KEY_GRANT_MAX_MS, type PermissionEntry } from "@tinycloud/node-sdk";

// TC-3284: `secrets network grant` signs with the owner's wallet (so `account revoke` can end it), lasts 1 h unless
// asked, is capped at 7 d like a runtime grant on a secret's key, and prints the expiry it signed. An OpenKey profile,
// which has no wallet key, is refused with Monica's S2j line before anything reaches the node.

const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:default";
const RECIPIENT = "did:key:z6MkRecipient";
const S2J = "This profile signs in through OpenKey, and `secrets network grant` needs your wallet's own key to sign the grant. Set `TC_PRIVATE_KEY` and rerun it, or use a profile set up with `tc init --key-only` and `tc auth login --method local`.";

let calls: { permissions: PermissionEntry[]; options: { expiry?: number; forceWalletSign?: boolean } }[] = [];
let outputs: Record<string, unknown>[] = [];
let errors: unknown[] = [];
let nodeCalls: string[] = [];
let profile: Record<string, unknown> = {};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    resolveContext: async () => ({ profile: "default", host: "https://tinycloud.test" }),
    getProfile: async () => profile,
    getSession: async () => null,
  },
}));

// The node signs the expiry it is asked for, as delegateTo does inside the session's own lifetime.
const node = {
  ensureEncryptionNetwork: async () => {
    nodeCalls.push("ensureEncryptionNetwork");
    return { networkId: NETWORK_ID };
  },
  delegateTo: async (_did: string, permissions: PermissionEntry[], options: { expiry: number; forceWalletSign?: boolean }) => {
    calls.push({ permissions, options });
    return {
      delegation: {
        cid: "bafy-grant",
        path: permissions[0]!.path,
        actions: permissions[0]!.actions,
        expiry: new Date(Date.now() + options.expiry),
      },
      prompted: true,
    };
  },
};
const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({
  ...realSdk,
  ensureAuthenticated: async () => {
    nodeCalls.push("ensureAuthenticated");
    return node;
  },
}));

const realFormatter = await import("../output/formatter.js");
mock.module("../output/formatter.js", () => ({
  ...realFormatter,
  outputJson: (payload: Record<string, unknown>) => { outputs.push(payload); },
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
}));

const realErrors = await import("../output/errors.js");
mock.module("../output/errors.js", () => ({ ...realErrors, handleError: (error: unknown) => { errors.push(error); } }));

const { registerSecretsCommand } = await import("./secrets.js");

async function grant(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>").option("--json");
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", "secrets", "network", "grant", RECIPIENT, ...args], { from: "node" });
}

/** The printed expiry's distance from now, within the test's own run time. */
function printedLifetimeMs(): number {
  return Date.parse(outputs[0]!.expiresAt as string) - Date.now();
}

const LOCAL_PROFILE = {
  name: "default", host: "https://tinycloud.test", chainId: 1, spaceName: "default",
  authMethod: "local", posture: "local-owner-key",
};
const OPENKEY_PROFILE = { ...LOCAL_PROFILE, authMethod: "openkey", posture: "owner-openkey" };
const originalPrivateKey = process.env.TC_PRIVATE_KEY;

beforeEach(() => {
  calls = [];
  outputs = [];
  errors = [];
  nodeCalls = [];
  profile = LOCAL_PROFILE;
  delete process.env.TC_PRIVATE_KEY;
});

afterAll(() => {
  if (originalPrivateKey === undefined) delete process.env.TC_PRIVATE_KEY;
  else process.env.TC_PRIVATE_KEY = originalPrivateKey;
});

test("a grant with no --expiry is wallet-signed for 1 h and prints that expiry", async () => {
  await grant();

  expect(errors).toEqual([]);
  expect(calls).toEqual([{
    permissions: [{ service: "tinycloud.encryption", path: NETWORK_ID, actions: ["decrypt"] }],
    options: { expiry: SECRET_KEY_GRANT_DEFAULT_MS, forceWalletSign: true },
  }]);
  expect(SECRET_KEY_GRANT_DEFAULT_MS).toBe(60 * 60_000);
  expect(printedLifetimeMs()).toBeGreaterThan(SECRET_KEY_GRANT_DEFAULT_MS - 60_000);
  expect(printedLifetimeMs()).toBeLessThanOrEqual(SECRET_KEY_GRANT_DEFAULT_MS);
});

test("--expiry 30d is capped at 7 d, and the output shows the 7 d expiry actually signed", async () => {
  await grant("--expiry", "30d");

  expect(errors).toEqual([]);
  expect(calls.map(({ options }) => options)).toEqual([{ expiry: SECRET_KEY_GRANT_MAX_MS, forceWalletSign: true }]);
  expect(SECRET_KEY_GRANT_MAX_MS).toBe(7 * 24 * 60 * 60_000);
  expect(printedLifetimeMs()).toBeGreaterThan(SECRET_KEY_GRANT_MAX_MS - 60_000);
  expect(printedLifetimeMs()).toBeLessThanOrEqual(SECRET_KEY_GRANT_MAX_MS);
});

test("--expiry under the cap is kept; a malformed one fails before anything is signed", async () => {
  await grant("--expiry", "2d");
  expect(calls.map(({ options }) => options.expiry)).toEqual([2 * 24 * 60 * 60_000]);

  calls = [];
  outputs = [];
  await grant("--expiry", "soon");
  expect(calls).toEqual([]);
  expect(outputs).toEqual([]);
  expect(errors).toHaveLength(1);
});

test("an OpenKey profile is refused with S2j before anything reaches the node", async () => {
  profile = OPENKEY_PROFILE;
  await grant();

  expect(nodeCalls).toEqual([]);
  expect(calls).toEqual([]);
  expect(outputs).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "AUTH_REQUIRED", message: S2J });
});

test("an OpenKey profile given a wallet key (TC_PRIVATE_KEY, or one stored on the profile) signs the grant", async () => {
  process.env.TC_PRIVATE_KEY = "11".repeat(32);
  profile = OPENKEY_PROFILE;
  await grant();
  delete process.env.TC_PRIVATE_KEY;
  profile = { ...OPENKEY_PROFILE, privateKey: "22".repeat(32) };
  await grant();

  expect(errors).toEqual([]);
  expect(calls.map(({ options }) => options.forceWalletSign)).toEqual([true, true]);
});
