import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

const outputs: unknown[] = [];
interface Permission { service: string; path: string; actions: string[] }
interface DelegateToCall { did: string; permissions: Permission[]; options?: { expiry?: number } }
const errors: unknown[] = [];
const delegateToCalls: DelegateToCall[] = [];
let authenticateCalls = 0;
let ensureNetworkCalls = 0;

const fakeNode = {
  ensureEncryptionNetwork: async () => {
    ensureNetworkCalls += 1;
    return { networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default" };
  },
  delegateTo: async (did: string, permissions: Permission[], options?: { expiry?: number }) => {
    delegateToCalls.push({ did, permissions, options });
    return {
      prompted: false,
      delegation: {
        cid: "bafy-grant",
        path: permissions[0].path,
        actions: permissions[0].actions,
        expiry: new Date(Date.now() + (options?.expiry ?? 0)),
      },
    };
  },
};

const actualErrors = await import("../output/errors.js");
mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "owner", host: "https://node.example.test" }) },
}));
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => {
    authenticateCalls += 1;
    return fakeNode;
  },
}));
mock.module("./auth.js", () => ({
  ensureDelegationAuthority: async () => undefined,
  refreshOpenKeySession: async () => undefined,
}));
mock.module("../output/formatter.js", () => ({
  outputJson: (value: unknown) => outputs.push(value),
  outputWarnings: () => undefined,
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, fn: () => unknown) => fn(),
  formatCheck: () => "",
  formatSection: () => "",
  operationWarnings: () => [],
}));
mock.module("../output/errors.js", () => ({
  ...actualErrors,
  handleError: (error: unknown) => errors.push(actualErrors.wrapError(error)),
}));

const { registerSecretsCommand } = await import("./secrets.js");

const recipient = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const HOUR_MS = 60 * 60 * 1000;

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerSecretsCommand(root);
  return root;
}

async function run(...args: string[]): Promise<void> {
  await program().parseAsync(["node", "tc", "secrets", "network", "grant", recipient, ...args]);
}

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  delegateToCalls.length = 0;
  authenticateCalls = 0;
  ensureNetworkCalls = 0;
});

describe("tc secrets network grant lifetime", () => {
  test("defaults to exactly one hour, passed explicitly, and reports the real expiry", async () => {
    await run();
    expect(errors).toEqual([]);
    expect(delegateToCalls).toHaveLength(1);
    expect(delegateToCalls[0].options).toEqual({ expiry: HOUR_MS });
    const output = outputs[0] as { expiry: string };
    const remaining = Date.parse(output.expiry) - Date.now();
    expect(remaining).toBeGreaterThan(HOUR_MS - 5_000);
    expect(remaining).toBeLessThanOrEqual(HOUR_MS);
  });

  test("--expiry 30m is passed as 30 minutes", async () => {
    await run("--expiry", "30m");
    expect(errors).toEqual([]);
    expect(delegateToCalls[0].options).toEqual({ expiry: 30 * 60 * 1000 });
  });

  test("--expiry 2h is refused with exit 2 before any sign-in, signature or request", async () => {
    await run("--expiry", "2h");
    expect(errors).toEqual([expect.objectContaining({ code: "DECRYPT_EXPIRY_TOO_LONG", exitCode: 2 })]);
    expect(delegateToCalls).toEqual([]);
    expect(authenticateCalls).toBe(0);
    expect(ensureNetworkCalls).toBe(0);
    expect(outputs).toEqual([]);
  });

  test("an unreadable --expiry is a usage error, not a silent default", async () => {
    await run("--expiry", "soon");
    expect(errors).toEqual([expect.objectContaining({ code: "USAGE_ERROR", exitCode: 2 })]);
    expect(delegateToCalls).toEqual([]);
  });

  test("help shows the option and its default", () => {
    const grant = program().commands
      .find((command) => command.name() === "secrets")!.commands
      .find((command) => command.name() === "network")!.commands
      .find((command) => command.name() === "grant")!;
    const help = grant.helpInformation();
    expect(help).toContain("--expiry <duration>");
    expect(help).toContain('default: "1h"');
  });
});
