import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry, type TinyCloudNode } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";
import { restoredOwnerNode } from "../test-support/restored-owner-node.js";

// TC-3125: `auth request --grant --timeout` leaves the approval link and resumes on a rerun. The wait itself, the saved request
// and the exit 8 payload are covered in the approval-request tests; these cover what the command decides: which combinations it
// refuses before anything is contacted, which approval each wait belongs to, and that a wait that ends activates nothing.

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-request-timeout-"));
process.env.TC_HOME = home;
const recordedErrors: unknown[] = [];
interface SeenFlow { permissions?: PermissionEntry[]; approvalWait?: { deadlineMs: number; step: number; of: number }; paste?: boolean }
const flows: SeenFlow[] = [];
let acquire: (did: string, options: SeenFlow) => Promise<unknown>;
const activated: unknown[] = [];
let node: TinyCloudNode;
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => node,
  bootstrapDelegatedSession: async () => node,
  restoreProfileSessionNode: async () => ({ unavailable: "session_missing" as const }),
}));
mock.module("../auth/browser-auth.js", () => ({
  startAuthFlow: async (did: string, options: SeenFlow) => {
    flows.push(options);
    return acquire(did, options);
  },
  validateDelegationCallbackPayload: () => null,
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number, public metadata?: Record<string, unknown>) {
      super(message);
    }
  },
  cliErrorFromService: (error: { code: string; message: string; meta?: Record<string, unknown> }) =>
    Object.assign(new Error(error.message), { code: error.code, exitCode: 1, metadata: error.meta }),
  handleError: (error: unknown) => { recordedErrors.push(error); },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));
mock.module("../output/formatter.js", () => ({
  operationWarnings: (value: unknown) => (Array.isArray(value) ? value : []),
  outputWarnings: () => {},
  isInteractive: () => false,
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, action: () => Promise<unknown>) => action(),
  outputJson: () => {},
  formatField: (label: string, value: unknown) => `${label}: ${value}`,
  formatTable: () => "",
}));

const { ProfileManager } = await import("../config/profiles.js");
const { registerAuthCommand } = await import("./auth.js");
const { approvalPendingError } = await import("../auth/approval-wait.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "secrets");
const manager = wasm.createSessionManager();
const jwk = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const host = "https://node.example.test";
node = await restoredOwnerNode({ wasm, signer, sessionKey: jwk, sessionDid: did, spaceId, host });
node.hasRuntimePermissions = () => false;
node.useRuntimeDelegation = async (delegation) => { activated.push(delegation); };
const openKey = openKeyDelegate({ wasm, signer, sessionKey: jwk, sessionDid: did });

const pending = (step: number, of: number) => approvalPendingError({
  step, of, approvalUrl: "https://openkey.example/approve/abc", expiresAt: new Date(Date.now() + 600_000).toISOString(),
}, true);

let profileName: string;
let profileNumber = 0;

beforeEach(async () => {
  recordedErrors.length = 0;
  flows.length = 0;
  activated.length = 0;
  acquire = async () => { throw new Error("no approval was expected"); };
  profileName = `request-timeout-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ defaultProfile: profileName, version: 1 });
  await ProfileManager.setKey(profileName, jwk);
  await ProfileManager.setProfile(profileName, {
    name: profileName, host, did, sessionDid: did, ownerDid, chainId: 1,
    spaceName: "secrets", spaceId, authMethod: "openkey", posture: "owner-openkey",
    operatorType: "human", createdAt: new Date().toISOString(),
  });
  await ProfileManager.setSession(profileName, { delegationCid: "existing-session", spaceId });
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function request(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>");
  registerAuthCommand(program);
  await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "request", ...args], { from: "node" });
}

const KEY = "tinycloud.kv:secrets:vault/KEY:get";
const OTHER = "tinycloud.kv:applications:notes/:get";

describe("auth request --grant --timeout", () => {
  test.each([
    ["without --grant (nothing is approved)", [] as string[], ["--emit"]],
    ["with --paste (a pasted code is not a saved request)", ["--grant", "--paste"], []],
    ["with --device (a device authorization is not a saved request)", ["--grant", "--device"], []],
  ])("--timeout %s is a usage error before anything is contacted", async (_name, grant, extra) => {
    await request("--cap", KEY, ...grant, ...extra, "--timeout", "60s");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2, message: expect.stringContaining("--timeout requires --grant") })]);
    expect(flows).toEqual([]);
  });

  test("a timeout that is not a duration is refused before anything is contacted", async () => {
    await request("--cap", KEY, "--grant", "--timeout", "never");
    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0]).toMatchObject({ exitCode: 2 });
    expect(flows).toEqual([]);
  });

  test("a wait that ends while the owner has not approved is exit 8 and activates nothing; no timeout waits as before", async () => {
    acquire = async (_did, options) => {
      if (options.approvalWait) throw pending(options.approvalWait.step, options.approvalWait.of);
      return openKey.delegate(did, options as never);
    };
    const before = Date.now();
    await request("--cap", KEY, "--grant", "--timeout", "60s", "--no-popup");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "APPROVAL_PENDING", exitCode: 8 })]);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.approvalWait).toMatchObject({ step: 1, of: 1 });
    expect(flows[0]!.approvalWait!.deadlineMs).toBeGreaterThanOrEqual(before + 59_000);
    expect(flows[0]!.approvalWait!.deadlineMs).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(activated).toEqual([]);

    recordedErrors.length = 0;
    flows.length = 0;
    await request("--cap", KEY, "--grant", "--no-popup");
    expect(recordedErrors).toEqual([]);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.approvalWait).toBeUndefined();
    expect(activated).toHaveLength(1);
  });

  test("one approval per space: the second space is step 2 of 2, and a wait that ends there activates nothing of the first", async () => {
    acquire = async (_did, options) => {
      if (options.approvalWait?.step === 2) throw pending(2, 2);
      return openKey.delegate(did, options as never);
    };
    await request("--cap", KEY, "--cap", OTHER, "--grant", "--timeout", "60s", "--no-popup");
    expect(flows.map((flow) => flow.approvalWait && [flow.approvalWait.step, flow.approvalWait.of])).toEqual([[1, 2], [2, 2]]);
    expect(flows[0]!.approvalWait!.deadlineMs).toBe(flows[1]!.approvalWait!.deadlineMs);
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "APPROVAL_PENDING", exitCode: 8 })]);
    expect(activated).toEqual([]);
  });
});
