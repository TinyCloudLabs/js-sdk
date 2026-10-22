import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry, type TinyCloudNode } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

interface HermeticFixture {
  host: string;
  ownerPrivateKey: string;
  ownerDid: string;
  owner: TinyCloudNode;
  delegate: TinyCloudNode;
  ownerRestorableSession: { jwk: Record<string, unknown>; verificationMethod: string; spaceId: string };
  permissions: PermissionEntry[];
  nativeBearerStats(): Readonly<{ revocations: number }>;
  stop(): void;
}
// URL loading keeps the node-sdk fixture outside the CLI package's TypeScript rootDir.
const { createHermeticEncryptedNode } = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(): Promise<HermeticFixture> };

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-revoke-openkey-"));
process.env.TC_HOME = home;
const fixture = await createHermeticEncryptedNode();
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => fixture.owner,
  bootstrapDelegatedSession: async () => fixture.owner,
  restoreProfileSessionNode: async () => ({ node: fixture.owner }),
}));
const authModule = await import("./auth.js");
const { REVOKE_AUTHORITY_EXPIRY } = await import("../lib/revoke-delegation.js");
const { ProfileManager } = await import("../config/profiles.js");
const { appendGrantHistory, loadLocalGrantArtifacts } = await import("../lib/permissions.js");
const { registerDelegationCommand } = await import("./delegation.js");
const { registerAuthCommand } = await import("./auth.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
const openKey = openKeyDelegate({
  wasm, signer, sessionKey: fixture.ownerRestorableSession.jwk,
  sessionDid: fixture.ownerRestorableSession.verificationMethod,
});
const profileName = "owner-revoke";
let responseBody: Record<string, unknown>;
const approvalExpiries: Array<string | number | undefined> = [];

beforeEach(async () => {
  openKey.requests.length = 0;
  openKey.refusals.length = 0;
  approvalExpiries.length = 0;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ defaultProfile: profileName, version: 1 });
  await ProfileManager.setKey(profileName, fixture.ownerRestorableSession.jwk);
  await ProfileManager.setProfile(profileName, {
    name: profileName, host: fixture.host, did: fixture.ownerRestorableSession.verificationMethod,
    sessionDid: fixture.ownerRestorableSession.verificationMethod,
    ownerDid: fixture.ownerDid, spaceId: fixture.ownerRestorableSession.spaceId,
    spaceName: "secrets", chainId: 1, authMethod: "openkey", posture: "owner-openkey",
    operatorType: "human", createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  fixture.stop();
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function revoke(cid: string) {
  responseBody = {};
  const previousExitCode = process.exitCode;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown): boolean => {
    try {
      const parsed = JSON.parse(String(chunk));
      if (parsed !== null && typeof parsed === "object") responseBody = parsed;
    } catch {
      // The test harness also writes non-JSON lines while these spies are active.
    }
    return true;
  };
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    capture(chunk);
    return originalStdout(chunk);
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    capture(chunk);
    return originalStderr(chunk);
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw Object.assign(new Error("CLI exited"), { cliExitCode: code });
  });
  const program = new Command();
  program.option("--profile <profile>");
  registerDelegationCommand(program, {
    openKeyAcquisition: async (did, options) => {
      approvalExpiries.push(options?.expiry);
      return await openKey.delegate(did, options);
    },
  });
  try {
    await program.parseAsync(["node", "tc", "--profile", profileName, "delegation", "revoke", cid, "--yes"], { from: "node" });
  } catch (error) {
    if (!(error instanceof Error && "cliExitCode" in error && (error.cliExitCode === 5 || error.cliExitCode === 4))) throw error;
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
    process.exitCode = previousExitCode;
  }
  return responseBody;
}

test("the OpenKey stand-in refuses a raw-CID plus owner-space request as production does", async () => {
  const cid = wasm.computeCid(new TextEncoder().encode("raw refusal"), 0x55n);
  await expect(openKey.delegate(fixture.ownerDid, { permissions: [
    { service: "tinycloud.delegation", space: `urn:cid:${cid}`, path: "", actions: ["tinycloud.delegation/revoke"] },
    { service: "tinycloud.capabilities", space: fixture.ownerRestorableSession.spaceId, path: "", actions: ["tinycloud.capabilities/read"] },
  ] })).rejects.toThrow("Authentication timed out after 5 minutes");
  expect(openKey.refusals).toEqual([{ code: "invalid_permissions", message: expect.stringContaining("single space") }]);
});

async function grantThroughCli() {
  const requestPath = join(home, "auth-request.json");
  await writeFile(requestPath, JSON.stringify({
    kind: "tinycloud.auth.request", version: 1, requestId: "t24-grant",
    sessionDid: fixture.delegate.sessionDid.split("#", 1)[0], requested: fixture.permissions,
  }));
  const owner = await ProfileManager.getProfile(profileName);
  await ProfileManager.setProfile(profileName, {
    ...owner, authMethod: "local", posture: "local-owner-key", privateKey: fixture.ownerPrivateKey,
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`tc auth grant exited ${code}`);
  });
  // The grant artifact contains signed authorization bytes: keep them out of test output.
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const program = new Command();
    program.option("--profile <profile>");
    registerAuthCommand(program);
    await program.parseAsync([
      "node", "tc", "--profile", profileName, "auth", "grant", requestPath, "--yes",
    ], { from: "node" });
  } finally {
    stdout.mockRestore();
    exit.mockRestore();
    await ProfileManager.setProfile(profileName, owner);
  }
  const artifacts = await loadLocalGrantArtifacts(profileName);
  expect(artifacts.length).toBeGreaterThan(0);
  const delegation = artifacts[artifacts.length - 1]!.delegation;
  await fixture.delegate.useRuntimeDelegation({ ...delegation, expiry: new Date(delegation.expiry) });
  return delegation;
}

test("owner OpenKey asks only for a signed CID-bound owner space, then revokes", async () => {
  const delegation = await grantThroughCli();
  const before = fixture.nativeBearerStats().revocations;
  const response = await revoke(delegation.cid);
  expect(response).toMatchObject({ cid: delegation.cid, revoked: true, authorityScopeSource: "local-signed-grant-artifact" });
  expect(openKey.requests).toHaveLength(1);
  expect(openKey.requests[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({ service: "tinycloud.delegation", space: delegation.spaceId, actions: ["tinycloud.delegation/revoke"] }),
    expect.objectContaining({ service: "tinycloud.capabilities", space: delegation.spaceId, actions: ["tinycloud.capabilities/read"] }),
  ]));
  expect(openKey.requests[0]?.some((permission) => permission.space?.startsWith("urn:cid:"))).toBe(false);
  expect(openKey.refusals).toEqual([]);
  expect(approvalExpiries).toEqual(["300s"]);
  expect(fixture.nativeBearerStats().revocations).toBe(before + 1);
});

test("both OpenKey revoke authority requests, raw CID then owner space, carry the short lifetime", async () => {
  const delegation = await grantThroughCli();
  const authority = spyOn(authModule, "ensureDelegationAuthority");
  try {
    await revoke(delegation.cid);
    expect(authority.mock.calls.map(([params]) => params.expiryOption)).toEqual([REVOKE_AUTHORITY_EXPIRY, REVOKE_AUTHORITY_EXPIRY]);
    expect(REVOKE_AUTHORITY_EXPIRY).toBe("5m");
  } finally {
    authority.mockRestore();
  }
});

test("a local-key owner's raw-CID revoke authority gets the same short lifetime", async () => {
  const delegation = await grantThroughCli();
  const owner = await ProfileManager.getProfile(profileName);
  await ProfileManager.setProfile(profileName, { ...owner, authMethod: "local", posture: "local-owner-key", privateKey: fixture.ownerPrivateKey });
  const grant = spyOn(fixture.owner, "grantRuntimePermissions");
  try {
    await revoke(delegation.cid);
    expect(grant.mock.calls.length).toBeGreaterThan(0);
    expect(grant.mock.calls[0]?.[1]).toEqual({ expiry: REVOKE_AUTHORITY_EXPIRY });
    expect(openKey.requests).toEqual([]);
  } finally {
    grant.mockRestore();
  }
});

test("without a matching signed grant OpenKey is never called and fails immediately", async () => {
  const cid = wasm.computeCid(new TextEncoder().encode("unknown revoke target"), 0x55n);
  await appendGrantHistory(profileName, {
    source: "cli", delegationCid: cid, addedCaps: [],
  });
  const before = fixture.nativeBearerStats().revocations;
  const response = await revoke(cid);
  expect(response).toMatchObject({ error: { code: "RAW_RECAP_RESOURCE_UNSUPPORTED" } });
  expect(openKey.requests).toEqual([]);
  expect(fixture.nativeBearerStats().revocations).toBe(before);
});

test("a session that cannot list delegations says so and where to revoke instead, without calling OpenKey", async () => {
  const cid = wasm.computeCid(new TextEncoder().encode("grant this profile cannot look up"), 0x55n);
  const before = fixture.nativeBearerStats().revocations;
  const response = await revoke(cid);
  expect(response).toMatchObject({ error: { code: "TARGET_NOT_FOUND" } });
  const message = String((response as { error: { message: string } }).error.message);
  expect(message).toContain("cannot list the owner's delegations");
  expect(message).toContain("profile that created the grant");
  expect(message).toContain("Delegations screen");
  expect(openKey.requests).toEqual([]);
  expect(fixture.nativeBearerStats().revocations).toBe(before);
});
