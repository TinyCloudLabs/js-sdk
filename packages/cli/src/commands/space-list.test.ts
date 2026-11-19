import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, type TinyCloudNode } from "@tinycloud/node-sdk";
import { restoredOwnerNode } from "../test-support/restored-owner-node.js";

interface HermeticFixture {
  host: string;
  ownerPrivateKey: string;
  ownerDid: string;
  owner: TinyCloudNode;
  accountSpaceId: string;
  applicationsSpaceId: string;
  requests(): readonly { method: string; path: string }[];
  invocations(): readonly { service: string; action: string; space: string; path: string }[];
  ownerRestorableSession: { jwk: Record<string, unknown>; verificationMethod: string; spaceId: string; delegationCid: string };
  allowInvocationProof(cid: string, options?: { spaceList?: boolean }): void;
  stop(): void;
}
// URL loading keeps the node-sdk fixture outside the CLI package's TypeScript rootDir.
const { createHermeticEncryptedNode } = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(): Promise<HermeticFixture> };

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-space-list-"));
process.env.TC_HOME = home;
const fixture = await createHermeticEncryptedNode();
fixture.allowInvocationProof(fixture.ownerRestorableSession.delegationCid);
let node: TinyCloudNode = fixture.owner;
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));
// Command modules load after the SDK boundary mock, so they cannot be static imports.
const { ProfileManager } = await import("../config/profiles.js");
const { registerSpaceCommand } = await import("./space.js");

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
const profileName = "owner";
// What OpenKey signs for a plain `tc auth login --method openkey`: kv, sql and
// capabilities read on the default space root (openkey delegate-session.ts DEFAULT_ABILITIES).
const openKeyDefaultNode = await restoredOwnerNode({
  wasm,
  signer,
  sessionKey: fixture.ownerRestorableSession.jwk,
  sessionDid: fixture.ownerRestorableSession.verificationMethod,
  spaceId: wasm.makeSpaceId(await signer.getAddress(), 1, "default"),
  host: fixture.host,
  abilities: {
    kv: { "": ["tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"] },
    sql: { "": ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] },
    capabilities: { "": ["tinycloud.capabilities/read"] },
  },
});
// A walletless restored session (as an OpenKey owner or delegate profile restores)
// whose signed recap holds tinycloud.space/list and no account-registry read.
const spaceListNode = await restoredOwnerNode({
  wasm,
  signer,
  sessionKey: fixture.ownerRestorableSession.jwk,
  sessionDid: fixture.ownerRestorableSession.verificationMethod,
  spaceId: wasm.makeSpaceId(await signer.getAddress(), 1, "default"),
  host: fixture.host,
  abilities: {
    space: { "": ["tinycloud.space/list"] },
    capabilities: { "": ["tinycloud.capabilities/read"] },
  },
});
fixture.allowInvocationProof(spaceListNode.restorableSession!.delegationCid, { spaceList: true });

async function writeProfile(posture: "owner-openkey" | "delegate-session"): Promise<void> {
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ defaultProfile: profileName, version: 1 });
  await ProfileManager.setKey(profileName, fixture.ownerRestorableSession.jwk);
  await ProfileManager.setProfile(profileName, {
    name: profileName, host: fixture.host, did: fixture.ownerRestorableSession.verificationMethod,
    sessionDid: fixture.ownerRestorableSession.verificationMethod,
    ownerDid: fixture.ownerDid, spaceId: fixture.ownerRestorableSession.spaceId,
    spaceName: "default", chainId: 1, authMethod: "openkey", posture,
    operatorType: "human", createdAt: new Date().toISOString(),
  });
}

async function runSpaceList(): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const originalOut = stdout.write;
  const originalErr = stderr.write;
  const originalExit = process.exit;
  let out = "";
  let err = "";
  let exitCode: number | undefined;
  stdout.write = (chunk: unknown) => { out += String(chunk); return true; };
  stderr.write = (chunk: unknown) => { err += String(chunk); return true; };
  process.exit = ((code?: number): never => {
    exitCode = code;
    throw new Error("expected process exit");
  }) as typeof process.exit;
  try {
    const program = new Command();
    registerSpaceCommand(program);
    await program.parseAsync(["node", "tc", "space", "list"], { from: "node" }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "expected process exit") throw error;
    });
  } finally {
    stdout.write = originalOut;
    stderr.write = originalErr;
    process.exit = originalExit;
  }
  return { stdout: out, stderr: err, exitCode };
}

beforeEach(() => writeProfile("owner-openkey"));

afterAll(async () => {
  fixture.stop();
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

test("an owner session without tinycloud.space/list lists its spaces from the account registry", async () => {
  node = fixture.owner;
  const before = fixture.invocations().length;

  const result = await runSpaceList();

  expect(result).toMatchObject({ exitCode: undefined, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({
    spaces: [{
      id: fixture.applicationsSpaceId,
      name: "applications",
      owner: fixture.ownerDid,
      type: "owned",
      permissions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      status: "active",
    }],
    count: 1,
  });
  const invoked = fixture.invocations().slice(before);
  expect(invoked.map(({ action, space, path }) => `${action} ${space.toLowerCase()} ${path}`)).toEqual([
    `tinycloud.kv/list ${fixture.accountSpaceId} spaces/`,
    `tinycloud.kv/get ${fixture.accountSpaceId} spaces/applications`,
  ]);
});

test("a walletless restored session holding tinycloud.space/list lists through the space/list fallback", async () => {
  node = spaceListNode;
  expect(spaceListNode.spaceId).toBe(wasm.makeSpaceId(await signer.getAddress(), 1, "default"));
  const before = fixture.invocations().length;

  const result = await runSpaceList();

  expect(result).toMatchObject({ exitCode: undefined, stderr: "" });
  const address = await signer.getAddress();
  expect(JSON.parse(result.stdout)).toEqual({
    spaces: [
      { id: wasm.makeSpaceId(address, 1, "secrets"), name: "secrets", owner: fixture.ownerDid, type: "owned", permissions: ["*"] },
      { id: wasm.makeSpaceId(address, 1, "applications"), name: "applications", owner: fixture.ownerDid, type: "owned", permissions: ["*"] },
    ],
    count: 2,
  });
  expect(fixture.invocations().slice(before).map(({ action }) => action)[0]).toBe("tinycloud.space/list");
});

test("a default OpenKey owner session is refused naming the missing capabilities, without a doomed request", async () => {
  node = openKeyDefaultNode;
  const before = fixture.requests().length;

  const result = await runSpaceList();

  expect(result.exitCode).toBe(5);
  expect(result.stdout).toBe("");
  const { error } = JSON.parse(result.stderr) as { error: { code: string; message: string; hint: string } };
  expect(error.code).toBe("PERMISSION_DENIED");
  expect(error.message).toContain("tinycloud.space/list");
  expect(error.message).toContain("tinycloud.kv/get and tinycloud.kv/list on the account space's spaces/ registry");
  expect(error.message.toLowerCase()).toContain(fixture.accountSpaceId);
  expect(error.message).not.toContain("not authenticated");
  expect(error.hint).toContain(`--profile ${profileName} auth request --grant --cap tinycloud.kv:account:spaces/:get,list`);
  expect(error.hint).toContain("default OpenKey owner sign-in covers only the default space");
  expect(fixture.requests().slice(before)).toEqual([]);
});

test("a delegate session without either capability is told to ask the owner", async () => {
  await writeProfile("delegate-session");
  node = openKeyDefaultNode;

  const result = await runSpaceList();

  expect(result.exitCode).toBe(5);
  const { error } = JSON.parse(result.stderr) as { error: { code: string; hint: string } };
  expect(error.code).toBe("PERMISSION_DENIED");
  expect(error.hint).toContain(`--profile ${profileName} auth request --cap tinycloud.kv:account:spaces/:get,list --emit`);
  expect(error.hint).not.toContain("--grant");
});
