import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry, type TinyCloudNode } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";
import { restoredOwnerNode } from "../test-support/restored-owner-node.js";

// TC-3153: `auth request --grant --fresh` asks the owner for a new approval although the current grants already cover the
// request, keeps the old grant, and lists its CID beside the new one. These cover what the command decides.

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-request-fresh-"));
process.env.TC_HOME = home;
const recordedErrors: unknown[] = [];
const outputs: unknown[] = [];
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
  outputJson: (value: unknown) => { outputs.push(value); },
  formatField: (label: string, value: unknown) => `${label}: ${value}`,
  formatTable: () => "",
}));

const { ProfileManager } = await import("../config/profiles.js");
const { appendAdditionalDelegation } = await import("../lib/permissions.js");
const { approvalPendingError } = await import("../auth/approval-wait.js");
const { registerAuthCommand } = await import("./auth.js");
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
let covered = true;
node.hasRuntimePermissions = () => covered;
node.useRuntimeDelegation = async (delegation) => { activated.push(delegation); };
const openKey = openKeyDelegate({ wasm, signer, sessionKey: jwk, sessionDid: did });

let profileName: string;
let profileNumber = 0;

beforeEach(async () => {
  recordedErrors.length = 0;
  outputs.length = 0;
  flows.length = 0;
  activated.length = 0;
  covered = true;
  acquire = async () => { throw new Error("no approval was expected"); };
  profileName = `request-fresh-${++profileNumber}`;
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

const OLD_CID = `bafkr4i${"o".repeat(52)}`;
const keyPermission: PermissionEntry = { service: "tinycloud.kv", space: "secrets", path: "vault/KEY", actions: ["tinycloud.kv/get"] };
async function storeOldGrant(): Promise<void> {
  await appendAdditionalDelegation(profileName, {
    delegation: { cid: OLD_CID, expiry: new Date(Date.now() + 86_400_000).toISOString() },
    permissions: [keyPermission],
  } as never);
}
async function storedCids(): Promise<string[]> {
  const { loadAdditionalDelegations } = await import("../lib/permissions.js");
  return (await loadAdditionalDelegations(profileName)).map((entry) => entry.delegation.cid);
}

describe("auth request --grant --fresh", () => {
  test("without --fresh a request the current grants already cover is changed: false, and the owner is not asked", async () => {
    await storeOldGrant();
    await request("--cap", KEY, "--grant", "--no-popup");
    expect(outputs).toEqual([{ changed: false, missing: [], added: [] }]);
    expect(flows).toEqual([]);
  });

  test("--fresh asks the owner although the grants cover it; the old grant stays, and both CIDs are listed", async () => {
    await storeOldGrant();
    acquire = async (_did, options) => openKey.delegate(did, options as never);
    await request("--cap", KEY, "--grant", "--fresh", "--no-popup");
    expect(recordedErrors).toEqual([]);
    expect(flows).toHaveLength(1);
    expect(activated).toHaveLength(1);
    const [output] = outputs as { changed: boolean; fresh: boolean; delegationCids: string[]; existingDelegationCids: string[] }[];
    expect(output).toMatchObject({ changed: true, fresh: true, existingDelegationCids: [OLD_CID] });
    expect(output!.delegationCids).toHaveLength(1);
    expect(output!.delegationCids).not.toContain(OLD_CID);
    expect(await storedCids()).toEqual([OLD_CID, ...output!.delegationCids]);
  });

  test("--fresh with no stored grant that covers it still asks, and lists none", async () => {
    acquire = async (_did, options) => openKey.delegate(did, options as never);
    await request("--cap", KEY, "--grant", "--fresh", "--no-popup");
    expect(outputs).toEqual([expect.objectContaining({ changed: true, fresh: true, existingDelegationCids: [] })]);
  });

  test("--fresh with --timeout leaves the link, exits 8, activates nothing, and keeps the old grant", async () => {
    await storeOldGrant();
    acquire = async (_did, options) => {
      if (options.approvalWait) throw approvalPendingError({ step: 1, of: 1, approvalUrl: "https://openkey.example/approve/abc", expiresAt: new Date(Date.now() + 600_000).toISOString() }, true);
      return openKey.delegate(did, options as never);
    };
    await request("--cap", KEY, "--grant", "--fresh", "--timeout", "60s", "--no-popup");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "APPROVAL_PENDING", exitCode: 8 })]);
    expect(activated).toEqual([]);
    expect(outputs).toEqual([]);
    expect(await storedCids()).toEqual([OLD_CID]);
  });

  test.each([
    ["without --grant", ["--fresh", "--emit"], "openkey"],
    ["on a local-key profile, which signs without asking", ["--grant", "--fresh"], "local"],
  ])("--fresh %s is a usage error before anything is contacted", async (_name, args, method) => {
    if (method === "local") {
      await ProfileManager.setProfile(profileName, {
        name: profileName, host, did, sessionDid: did, ownerDid, chainId: 1, spaceName: "secrets", spaceId,
        authMethod: "local", posture: "local-owner-key", operatorType: "human", createdAt: new Date().toISOString(),
      });
    }
    await request("--cap", KEY, ...args);
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2, message: expect.stringContaining("--fresh requires --grant on an OpenKey owner profile") })]);
    expect(flows).toEqual([]);
    expect(activated).toEqual([]);
  });
});
