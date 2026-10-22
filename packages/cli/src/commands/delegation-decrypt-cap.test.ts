import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

const outputs: unknown[] = [];
interface Permission { service: string; space: string; path: string; actions: string[] }
interface DelegateToCall { did: string; permissions: Permission[]; options: { expiry: number; requireActivation?: boolean } }
const errors: unknown[] = [];
const delegateToCalls: DelegateToCall[] = [];
let delegateToFailure: Error | undefined;

const fakeNode = {
  delegateTo: async (did: string, permissions: Permission[], options: { expiry: number; requireActivation?: boolean }) => {
    delegateToCalls.push({ did, permissions, options });
    if (delegateToFailure) throw delegateToFailure;
    return { delegation: { cid: "bafy-created", expiry: new Date(Date.now() + options.expiry) }, prompted: false };
  },
  account: {
    delegations: {
      query: async () => ({
        ok: true,
        data: {
          schemaVersion: 2,
          items: [{
            cid: "bafy-created",
            direction: "granted",
            delegatorDid: "did:key:z6Mkowner",
            delegateDid: "did:key:z6Mkrecipient",
            resources: [],
            parents: [],
            issuedAt: new Date(),
            notBefore: null,
            expiresAt: new Date(Date.now() + 3600_000),
            status: "active",
          }],
          nextCursor: undefined,
        },
      }),
    },
  },
};

const actualErrors = await import("../output/errors.js");
mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "owner", host: "https://node.example.test" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => fakeNode }));
mock.module("./auth.js", () => ({ finishProfileLogout: async () => 0, prepareProfileRemoteLogout: async () => undefined }));
mock.module("../lib/revoke-delegation.js", () => ({ revokeDelegationOnNode: async () => ({}) }));
mock.module("../output/formatter.js", () => ({
  outputJson: (value: unknown) => outputs.push(value),
  isInteractive: () => false,
}));
mock.module("../output/errors.js", () => ({
  ...actualErrors,
  handleError: (error: unknown) => errors.push(actualErrors.wrapError(error)),
}));

const { registerDelegationCommand } = await import("./delegation.js");

const recipient = "did:key:z6Mkrecipient";
const HOUR_MS = 60 * 60 * 1000;

async function create(actions: string, ...extra: string[]): Promise<void> {
  const program = new Command();
  registerDelegationCommand(program);
  await program.parseAsync(["node", "tc", "delegation", "create", "--to", recipient, "--path", "p/", "--actions", actions, ...extra]);
}

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  delegateToCalls.length = 0;
  delegateToFailure = undefined;
});

describe("tc delegation create with decrypt", () => {
  test("--expiry 2h is refused with exit 2 before anything is signed", async () => {
    await create("kv/get,encryption/decrypt", "--expiry", "2h");
    expect(errors).toEqual([expect.objectContaining({ code: "DECRYPT_EXPIRY_TOO_LONG", exitCode: 2 })]);
    expect(delegateToCalls).toEqual([]);
  });

  test("the default lifetime is one hour", async () => {
    await create("encryption/decrypt");
    expect(errors).toEqual([]);
    const { expiry } = delegateToCalls[0].options;
    expect(expiry).toBeGreaterThan(HOUR_MS - 5_000);
    expect(expiry).toBeLessThanOrEqual(HOUR_MS);
  });

  test("an SDK-thrown DECRYPT_EXPIRY_TOO_LONG maps to exit 2", async () => {
    delegateToFailure = Object.assign(new Error("decrypt grants last at most one hour"), { code: "DECRYPT_EXPIRY_TOO_LONG" });
    await create("encryption/decrypt", "--expiry", "30m");
    expect(delegateToCalls).toHaveLength(1);
    expect(errors).toEqual([expect.objectContaining({ code: "DECRYPT_EXPIRY_TOO_LONG", exitCode: 2 })]);
  });
});

describe("tc delegation create without decrypt", () => {
  test("a 7d kv-only delegation keeps its lifetime and arguments", async () => {
    await create("kv/get", "--expiry", "7d");
    expect(errors).toEqual([]);
    expect(delegateToCalls).toHaveLength(1);
    const { did, permissions, options } = delegateToCalls[0];
    expect(did).toBe(recipient);
    expect(permissions).toEqual([{ service: "tinycloud.kv", space: "default", path: "p/", actions: ["tinycloud.kv/get"] }]);
    expect(options.requireActivation).toBe(true);
    expect(options.expiry).toBeGreaterThan(7 * 24 * HOUR_MS - 5_000);
    expect(options.expiry).toBeLessThanOrEqual(7 * 24 * HOUR_MS);
  });

  test("a network create action is not decrypt and keeps a long lifetime", async () => {
    await create("encryption/network.create", "--expiry", "2h");
    expect(errors).toEqual([]);
    expect(delegateToCalls).toHaveLength(1);
  });
});
