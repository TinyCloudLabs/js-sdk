import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry, PortableDelegation } from "@tinycloud/node-sdk";
import type { OpenKeyAcquisition } from "./auth.js";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

const home = await mkdtemp(join(tmpdir(), "tc-auth-grants-"));
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
process.env.HOME = home;
process.env.TC_HOME = home;
delete process.env.TC_HOST;

// CLI config paths capture TC_HOME on import, so modules load only after the test home is set.
const { createAuthRuntimeFixture } = await import(new URL("../../../operations/test-support/auth-runtime.ts", import.meta.url).href);
const { additionalDelegationsPath, profileConfigPath, profilePath, readAdditionalDelegations, sessionPath, writeJsonAtomic } = await import("@tinycloud/operations/state");
const { registerAuthGrantsCommand } = await import("./auth-grants.js");
const { grantRequestPermissions } = await import("../auth/scoped-login.js");
const { cliGrantRecord } = await import("../lib/permissions.js");
const { portableFromOpenKeyDelegation } = await import("./auth.js");
const { ProfileManager } = await import("../config/profiles.js");
const { discardWarnings } = await import("../output/warnings.js");

/** The runtime fixture exposes real node-sdk grants; operations' own test interface is deliberately narrower. */
interface Fixture {
  profile: string;
  ownerProfile: string;
  sessionDid: string;
  hermetic: {
    host: string;
    ownerDid: string;
    ownerPrivateKey: string;
    accountSpaceId: string;
    permissions: readonly PermissionEntry[];
    ownerRestorableSession: { jwk: object };
    mintDelegation(): Promise<PortableDelegation>;
    nativeBearerStats(): Readonly<{
      delegations: number;
      delegationAttempts: number;
      revocations: number;
      revokedInvocations: number;
      kvReads: number;
      kvWrites: number;
    }>;
    rejectRootRawCidActivations(refuse: boolean): void;
    stop(): void;
  };
}
let fixture: Fixture;

beforeAll(async () => {
  // The operations fixture narrows its portable delegation shape for its own assertions.
  fixture = await createAuthRuntimeFixture() as unknown as Fixture;
});
afterAll(async () => {
  fixture?.hermetic.stop();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

async function command(profile: string, args: string[], acquisition?: OpenKeyAcquisition) {
  let stdout = "";
  let stderr = "";
  const out = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const err = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error("command exited"), { commandExitCode: code });
  }) as typeof process.exit);
  let code = 0;
  try {
    const program = new Command();
    program.option("-p, --profile <name>").option("--json");
    const auth = program.command("auth");
    registerAuthGrantsCommand(auth, { openKeyAcquisition: acquisition });
    await program.parseAsync(["node", "tc", "--profile", profile, "--json", "auth", "grants", ...args], { from: "node" });
  } catch (error) {
    if (!error || typeof error !== "object" || !("commandExitCode" in error)) throw error;
    code = error.commandExitCode as number;
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
    discardWarnings("");
  }
  return { code, stdout, stderr, output: stdout ? JSON.parse(stdout) : null, error: stderr ? JSON.parse(stderr) : null };
}

function bound(delegation: object & { cid: string }, requestId = "cli-grant") {
  return {
    delegation,
    permissions: [{ service: "tinycloud.kv", path: "display-only", actions: ["tinycloud.kv/get"] }],
    authorityRequest: { requestId: `${requestId}:${delegation.cid}`, requested: fixture.hermetic.permissions },
    authorityRequestAudit: { source: requestId, note: "UNTRUSTED_CANARY" },
  };
}

function flipSignature(authorization: string): string {
  const fields = authorization.split(".");
  fields[2] = `${fields[2]![0] === "A" ? "B" : "A"}${fields[2]!.slice(1)}`;
  return fields.join(".");
}

test("list locally verifies real Bearer compact grants, reports refused and unchecked rows, never contacts node", async () => {
  const compact = await fixture.hermetic.mintDelegation();
  const bearer = {
    ...compact,
    delegationHeader: { Authorization: `Bearer ${compact.delegationHeader.Authorization}` },
    cid: new TinyCloudNode({ host: fixture.hermetic.host }).computeDelegationCid(`Bearer ${compact.delegationHeader.Authorization}`),
  };
  const invalidAuthorization = flipSignature(compact.delegationHeader.Authorization);
  const invalid = {
    ...compact,
    delegationHeader: { Authorization: invalidAuthorization },
    cid: new TinyCloudNode({ host: fixture.hermetic.host }).computeDelegationCid(invalidAuthorization),
  };
  const stale = { ...compact, expiry: new Date(0) };
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [
    bound(bearer), bound(invalid, "migrated"), bound(stale),
    { ...bound(compact), authorityRequest: undefined },
    { delegation: { ...compact, delegationHeader: { Authorization: "old proofless grant" } }, permissions: [] },
    bound(compact, "req_fixture"),
    bound(compact, "unbound-import"),
    { delegation: { ...compact, cid: "UNTRUSTED_CANARY", delegationHeader: { Authorization: "malformed", Extra: "UNTRUSTED_CANARY" } }, permissions: [] },
  ]);
  const before = fixture.hermetic.nativeBearerStats();
  const fetch = spyOn(globalThis, "fetch");
  try {
    const listed = await command(fixture.profile, ["list"]);
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.output).toMatchObject({
      profile: fixture.profile,
      localVerification: "available",
      session: { cid: expect.stringMatching(/^bafkr4i[a-z2-7]{52}$/), expiresAt: null },
    });
    expect(listed.output.grants).toHaveLength(8);
    expect(listed.output.grants.map((row: { index: number }) => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(listed.output.grants[0]).toMatchObject({ cid: bearer.cid, local: "verified", node: "not_checked", bound: true, proof: "compact", source: "cli-grant", scopeSource: "signed" });
    expect(listed.output.grants[1]).toMatchObject({ cid: invalid.cid, local: "refused", reason: "proof_invalid", node: "not_checked", source: "migration" });
    expect(listed.output.grants[2]).toMatchObject({ local: "not_checked", expired: true, node: "not_checked" });
    expect(listed.output.grants[3]).toMatchObject({ local: "refused", reason: "unbound", bound: false });
    expect(listed.output.grants[4]).toMatchObject({ local: "refused", reason: "proof_missing", source: "legacy", proof: "missing" });
    expect(listed.output.grants[5]).toMatchObject({ local: "verified", source: "request", node: "not_checked" });
    expect(listed.output.grants[6]).toMatchObject({ local: "verified", source: "unbound-import", node: "not_checked" });
    expect(listed.output.grants[7]).toMatchObject({ cid: null, node: "not_checked", source: "unknown" });
    expect(listed.stdout).not.toContain("UNTRUSTED_CANARY");
    expect(listed.stdout).not.toContain(fixture.hermetic.host);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.hermetic.nativeBearerStats()).toEqual(before);
  } finally {
    fetch.mockRestore();
  }
});

test("list with no session performs no sign-in and reports session_missing", async () => {
  const original = await readFile(sessionPath(fixture.profile));
  await rm(sessionPath(fixture.profile));
  try {
    const fetch = spyOn(globalThis, "fetch");
    try {
      const result = await command(fixture.profile, ["list"]);
      expect(result.code).toBe(0);
      expect(result.output).toMatchObject({ session: null, localVerification: "session_missing" });
      expect(result.output.grants.every((row: { node: string; local: string }) => row.node === "not_checked" && row.local !== "verified")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  } finally { await writeFile(sessionPath(fixture.profile), original); }
});

test("remove deletes every exact CID while preserving unrelated records, and a later list stays local", async () => {
  const first = await fixture.hermetic.mintDelegation();
  const second = await fixture.hermetic.mintDelegation();
  const other = { ...second, cid: first.cid + "different" };
  const rows = [bound(first), bound(other), { ...bound(first), permissions: [] }];
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), rows);
  const removed = await command(fixture.profile, ["remove", first.cid]);
  expect(removed).toMatchObject({ code: 0, output: { profile: fixture.profile, cid: first.cid, removed: 2, revoked: false } });
  const remaining = await readAdditionalDelegations(fixture.profile);
  expect(remaining).toEqual([JSON.parse(JSON.stringify(rows[1]))]);
  const later = await command(fixture.profile, ["list"]);
  expect(later.output.grants).toHaveLength(1);
  expect(later.output.grants[0].cid).toBe(null);
});

test("unknown CID, malformed CID and non-array store never rewrite local data", async () => {
  const path = additionalDelegationsPath(fixture.profile);
  const grant = await fixture.hermetic.mintDelegation();
  await writeJsonAtomic(path, [bound(grant)]);
  const data = await readFile(path, "utf8");
  const before = (await stat(path)).mtimeMs;
  const absent = await command(fixture.profile, ["remove", "bafkr4i" + "a".repeat(52)]);
  expect(absent).toMatchObject({ code: 4, error: { error: { code: "GRANT_NOT_FOUND" } } });
  expect(await readFile(path, "utf8")).toBe(data);
  expect((await stat(path)).mtimeMs).toBe(before);
  const malformed = await command(fixture.profile, ["remove", "UNTRUSTED_CANARY"]);
  expect(malformed).toMatchObject({ code: 2, error: { error: { code: "INVALID_ARGUMENT" } } });
  expect(await readFile(path, "utf8")).toBe(data);
  await writeJsonAtomic(path, { records: [bound(grant)] });
  const nonArray = await readFile(path, "utf8");
  const unknown = await command(fixture.profile, ["remove", grant.cid]);
  expect(unknown).toMatchObject({ code: 4, error: { error: { code: "GRANT_NOT_FOUND" } } });
  expect(await readFile(path, "utf8")).toBe(nonArray);
});

test("delegate-session revoke gate precedes consent and every node/OpenKey request for every authMethod", async () => {
  const delegation = await fixture.hermetic.mintDelegation();
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [bound(delegation)]);
  const { profileConfigPath } = await import("@tinycloud/operations/state");
  const configPath = profileConfigPath(fixture.profile);
  const original = await readFile(configPath);
  const stored = await readFile(additionalDelegationsPath(fixture.profile), "utf8");
  try {
    for (const method of ["openkey", "local", undefined]) {
      const profile = JSON.parse(original.toString());
      if (method === undefined) delete profile.authMethod;
      else profile.authMethod = method;
      await writeJsonAtomic(configPath, profile);
      let acquisitions = 0;
      const fetch = spyOn(globalThis, "fetch");
      try {
        const denied = await command(fixture.profile, ["remove", delegation.cid, "--revoke"], async () => { acquisitions++; throw new Error("unexpected OpenKey request"); });
        expect(denied).toMatchObject({ code: 5, error: { error: { code: "REVOKE_UNAUTHORIZED" } } });
        expect(acquisitions).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
        expect(await readFile(additionalDelegationsPath(fixture.profile), "utf8")).toBe(stored);
      } finally { fetch.mockRestore(); }
    }
  } finally { await writeFile(configPath, original); }
});

test("owner revoke requires consent before mutation, and OpenKey without verified fallback fails immediately", async () => {
  const target = await fixture.hermetic.mintDelegation();
  const proofless = { ...target, delegationHeader: { Authorization: "old proofless grant" } };
  const path = additionalDelegationsPath(fixture.ownerProfile);
  await writeJsonAtomic(path, [{ delegation: proofless, permissions: [] }]);
  const old = await readFile(path, "utf8");
  const noConsent = await command(fixture.ownerProfile, ["remove", target.cid, "--revoke"]);
  expect(noConsent).toMatchObject({ code: 2, error: { error: { code: "CONFIRMATION_REQUIRED" } } });
  expect(await readFile(path, "utf8")).toBe(old);
  expect(fixture.hermetic.nativeBearerStats().revocations).toBe(0);
});

test("owner-openkey with no verified CID-bound space refuses raw-CID revoke without opening OpenKey", async () => {
  const target = await fixture.hermetic.mintDelegation();
  const path = additionalDelegationsPath(fixture.ownerProfile);
  const { profileConfigPath } = await import("@tinycloud/operations/state");
  const configPath = profileConfigPath(fixture.ownerProfile);
  const originalProfile = await readFile(configPath);
  await writeJsonAtomic(configPath, { ...JSON.parse(originalProfile.toString()), authMethod: "openkey", posture: "owner-openkey" });
  await writeJsonAtomic(path, [{ delegation: { ...target, delegationHeader: { Authorization: "proof absent" } }, permissions: [] }]);
  const before = await readFile(path, "utf8");
  let acquisitions = 0;
  try {
    const denied = await command(fixture.ownerProfile, ["remove", target.cid, "--revoke", "--yes"], async () => {
      acquisitions++;
      throw new Error("OpenKey must not receive a raw-CID request");
    });
    expect(denied).toMatchObject({ code: 5, error: { error: { code: "RAW_RECAP_RESOURCE_UNSUPPORTED" } } });
    expect(acquisitions).toBe(0);
    expect(fixture.hermetic.nativeBearerStats().revocations).toBe(0);
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await writeFile(configPath, originalProfile);
  }
});

test("owner-openkey revokes a verified stored CACAO through the CID-bound owner space before removing rows", async () => {
  const ownerSession = fixture.hermetic.ownerRestorableSession;
  const originalProfile = await readFile(profileConfigPath(fixture.ownerProfile));
  const keyPath = join(profilePath(fixture.ownerProfile), "key.json");
  const owner = JSON.parse(originalProfile.toString());
  await writeJsonAtomic(profileConfigPath(fixture.ownerProfile), {
    ...owner, authMethod: "openkey", posture: "owner-openkey", ownerDid: fixture.hermetic.ownerDid,
  });
  await writeJsonAtomic(keyPath, ownerSession.jwk);
  const wasm = new NodeWasmBindings();
  const openKey = openKeyDelegate({
    wasm,
    signer: new PrivateKeySigner(fixture.hermetic.ownerPrivateKey),
    sessionKey: ownerSession.jwk as object,
    sessionDid: owner.sessionDid as string,
  });
  try {
    const request = grantRequestPermissions([{
      service: "tinycloud.kv", space: fixture.hermetic.accountSpaceId,
      path: "notes", actions: ["tinycloud.kv/get"],
    }], fixture.hermetic.accountSpaceId);
    const signed = await openKey.delegate(owner.did, { permissions: request });
    const grant = portableFromOpenKeyDelegation(signed, request, fixture.hermetic.host, {
      key: ownerSession.jwk as object,
      sessionDid: owner.sessionDid as string,
      expectedOwner: fixture.hermetic.ownerDid,
    });
    const { restoreProfileSessionNode } = await import("../lib/sdk.js");
    const restored = await restoreProfileSessionNode({
      profile: fixture.ownerProfile, host: fixture.hermetic.host, verbose: false, noCache: false, quiet: true,
    });
    if (!("node" in restored)) throw new Error(`owner session unavailable: ${restored.unavailable}`);
    const row = await cliGrantRecord(restored.node, grant, request, fixture.hermetic.host);
    await writeJsonAtomic(additionalDelegationsPath(fixture.ownerProfile), [row, row]);
    const beforeInspection = fixture.hermetic.nativeBearerStats();
    const listed = await command(fixture.ownerProfile, ["list"]);
    expect(listed.code).toBe(0);
    expect(listed.output.grants[0]).toMatchObject({
      cid: grant.cid, local: "verified", node: "not_checked", proof: "siwe",
      scopeSource: "signed", source: "cli-grant",
    });
    expect(fixture.hermetic.nativeBearerStats()).toEqual(beforeInspection);
    await restored.node.useRuntimeDelegation(grant);
    openKey.requests.length = 0;
    const before = fixture.hermetic.nativeBearerStats().revocations;
    const removed = await command(fixture.ownerProfile, ["remove", grant.cid, "--revoke", "--yes"], (did, options) =>
      openKey.delegate(did, options));
    expect(removed).toMatchObject({
      code: 0,
      output: { cid: grant.cid, revoked: true, removed: 2, authorityScopeSource: "local-stored-grant" },
    });
    expect(openKey.requests).toHaveLength(1);
    const signedSpace = fixture.hermetic.accountSpaceId.toLowerCase();
    expect(openKey.requests[0]?.map((permission) => ({ ...permission, space: permission.space?.toLowerCase() })))
      .toContainEqual(expect.objectContaining({
        service: "tinycloud.delegation", space: signedSpace, actions: ["tinycloud.delegation/revoke"],
      }));
    expect(openKey.requests[0]?.map((permission) => ({ ...permission, space: permission.space?.toLowerCase() })))
      .toContainEqual(expect.objectContaining({
        service: "tinycloud.capabilities", space: signedSpace, actions: ["tinycloud.capabilities/read"],
      }));
    expect(JSON.stringify(openKey.requests)).not.toContain("urn:cid:");
    expect(openKey.refusals).toEqual([]);
    expect(fixture.hermetic.nativeBearerStats().revocations).toBe(before + 1);
    expect(await readAdditionalDelegations(fixture.ownerProfile)).toEqual([]);
  } finally {
    await writeFile(profileConfigPath(fixture.ownerProfile), originalProfile);
    await rm(keyPath, { force: true });
  }
});

const runtimes: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["src", [process.execPath, join(import.meta.dir, "../index.ts")]],
  ["built", [process.env.NODE_BINARY ?? "node", join(import.meta.dir, "../../bin/tc")]],
];

async function publicCommand(runtime: readonly string[], profile: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  const child = Bun.spawn([...runtime, "--quiet", "--json", "--profile", profile, "auth", "grants", ...args], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test.each(runtimes)("public %s list is local and public remove preserves other grants", async (_name, runtime) => {
  const delegation = await fixture.hermetic.mintDelegation();
  const authorization = `Bearer ${delegation.delegationHeader.Authorization}`;
  const bearer = {
    ...delegation,
    delegationHeader: { Authorization: authorization },
    cid: new TinyCloudNode({ host: fixture.hermetic.host }).computeDelegationCid(authorization),
  };
  const other = await fixture.hermetic.mintDelegation();
  const path = additionalDelegationsPath(fixture.profile);
  const rows = [bound(bearer), bound(other)];
  await writeJsonAtomic(path, rows);
  const before = fixture.hermetic.nativeBearerStats();
  const list = await publicCommand(runtime, fixture.profile, ["list"]);
  expect({ code: list.code, stderr: list.stderr }).toEqual({ code: 0, stderr: "" });
  const parsed = JSON.parse(list.stdout);
  expect(parsed).toMatchObject({ localVerification: "available" });
  expect(parsed.grants[0]).toMatchObject({ cid: bearer.cid, local: "verified", node: "not_checked", proof: "compact", scopeSource: "signed" });
  expect(parsed.grants[1].node).toBe("not_checked");
  expect(list.stdout).not.toContain("UNTRUSTED_CANARY");
  expect(fixture.hermetic.nativeBearerStats()).toEqual(before);

  const remove = await publicCommand(runtime, fixture.profile, ["remove", bearer.cid]);
  expect({ code: remove.code, stderr: remove.stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(remove.stdout)).toMatchObject({ cid: bearer.cid, removed: 1, revoked: false });
  expect(await readAdditionalDelegations(fixture.profile)).toEqual([JSON.parse(JSON.stringify(rows[1]))]);
}, 30_000);

test.each(runtimes)("public %s delegate-session --revoke refuses before node access", async (_name, runtime) => {
  const delegation = await fixture.hermetic.mintDelegation();
  const path = additionalDelegationsPath(fixture.profile);
  await writeJsonAtomic(path, [bound(delegation)]);
  const before = await readFile(path, "utf8");
  const stats = fixture.hermetic.nativeBearerStats();
  const denied = await publicCommand(runtime, fixture.profile, ["remove", delegation.cid, "--revoke"]);
  expect(denied.code).toBe(5);
  expect(JSON.parse(denied.stderr)).toMatchObject({ error: { code: "REVOKE_UNAUTHORIZED" } });
  expect(await readFile(path, "utf8")).toBe(before);
  expect(fixture.hermetic.nativeBearerStats()).toEqual(stats);
}, 30_000);

test.each(runtimes)("public %s --json list on a PTY emits only JSON, with no node traffic", async (_name, runtime) => {
  const delegation = await fixture.hermetic.mintDelegation();
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [bound(delegation)]);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  const before = fixture.hermetic.nativeBearerStats();
  const child = Bun.spawn([
    "python3", join(import.meta.dir, "../../test-support/pty-run.py"),
    ...runtime, "--quiet", "--json", "--profile", fixture.profile, "auth", "grants", "list",
  ], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [result, errors, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
  const report = JSON.parse(result);
  expect(report.exit).toBe(0);
  expect(report.stderr).toBe("");
  expect(JSON.parse(report.stdout).grants[0]).toMatchObject({ node: "not_checked", local: "verified" });
  expect(fixture.hermetic.nativeBearerStats()).toEqual(before);
}, 30_000);

test.each(runtimes)("public %s local-owner-key uses its real raw-CID authority before deleting the grant", async (_name, runtime) => {
  const delegation = await fixture.hermetic.mintDelegation();
  const { restoreProfileSessionNode } = await import("../lib/sdk.js");
  const restored = await restoreProfileSessionNode({
    profile: fixture.profile, host: fixture.hermetic.host, verbose: false, noCache: false, quiet: true,
  });
  if (!("node" in restored)) throw new Error(`delegate session unavailable: ${restored.unavailable}`);
  await restored.node.useRuntimeDelegation(delegation);
  const path = additionalDelegationsPath(fixture.ownerProfile);
  await writeJsonAtomic(path, [bound(delegation)]);
  const before = fixture.hermetic.nativeBearerStats().revocations;
  const removed = await publicCommand(runtime, fixture.ownerProfile, ["remove", delegation.cid, "--revoke", "--yes"]);
  expect({ code: removed.code, stderr: removed.stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(removed.stdout)).toMatchObject({
    profile: fixture.ownerProfile, cid: delegation.cid, removed: 1, revoked: true,
    authorityScopeSource: "cid-resource",
  });
  expect(fixture.hermetic.nativeBearerStats().revocations).toBe(before + 1);
  expect(await readAdditionalDelegations(fixture.ownerProfile)).toEqual([]);
}, 30_000);

test.each(runtimes)("public %s local owner falls back when the node refuses root raw-CID authority", async (_name, runtime) => {
  const delegation = await fixture.hermetic.mintDelegation();
  const path = additionalDelegationsPath(fixture.ownerProfile);
  await writeJsonAtomic(path, [bound(delegation)]);
  fixture.hermetic.rejectRootRawCidActivations(true);
  try {
    const before = fixture.hermetic.nativeBearerStats();
    const result = await publicCommand(runtime, fixture.ownerProfile, ["remove", delegation.cid, "--revoke", "--yes"]);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: fixture.ownerProfile, cid: delegation.cid, revoked: true, removed: 1,
      targetSpaceSource: "local-stored-grant", authorityScopeSource: "local-stored-grant",
    });
    const after = fixture.hermetic.nativeBearerStats();
    expect(after.delegationAttempts).toBe(before.delegationAttempts + 2);
    expect(after.delegations).toBe(before.delegations + 1);
    expect(after.revocations).toBe(before.revocations + 1);
    expect(await readAdditionalDelegations(fixture.ownerProfile)).toEqual([]);
  } finally {
    fixture.hermetic.rejectRootRawCidActivations(false);
  }
}, 30_000);

test.each(runtimes)("public %s node refusal keeps the exact local stored grant bytes", async (_name, runtime) => {
  const signed = await fixture.hermetic.mintDelegation();
  // The stored CID is well-formed but not a delegation registered at this
  // node. The real local signer can issue raw-CID authority, and the node
  // itself must reject the revoke rather than allowing local deletion.
  const target = {
    ...signed,
    cid: new TinyCloudNode({ host: fixture.hermetic.host })
      .computeDelegationCid(`not-on-node:${signed.delegationHeader.Authorization}`),
  };
  const path = additionalDelegationsPath(fixture.ownerProfile);
  await writeJsonAtomic(path, [bound(target)]);
  const before = await readFile(path, "utf8");
  const priorRevocations = fixture.hermetic.nativeBearerStats().revocations;
  const refused = await publicCommand(runtime, fixture.ownerProfile, ["remove", target.cid, "--revoke", "--yes"]);
  expect(refused.code).not.toBe(0);
  expect(JSON.parse(refused.stderr)).toMatchObject({
    error: { code: expect.any(String), message: expect.stringContaining("Delegation not found") },
  });
  expect(await readFile(path, "utf8")).toBe(before);
  expect(fixture.hermetic.nativeBearerStats().revocations).toBe(priorRevocations);
}, 30_000);

test("local removal waits for the profile lock without touching the store", async () => {
  const target = await fixture.hermetic.mintDelegation();
  const path = additionalDelegationsPath(fixture.profile);
  await writeJsonAtomic(path, [bound(target)]);
  const old = await readFile(path, "utf8");
  const signal = join(home, "grants-removal-contended");
  const originalSignal = process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = signal;
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const holding = ProfileManager.withLock(fixture.profile, async () => {
    entered.resolve();
    await proceed.promise;
  });
  try {
    await entered.promise;
    const removing = command(fixture.profile, ["remove", target.cid]);
    while (!(await stat(signal).then(() => true, () => false))) { /* each stat yields to the waiting writer */ }
    expect(await readFile(path, "utf8")).toBe(old);
    proceed.resolve();
    await holding;
    expect(await removing).toMatchObject({ code: 0, output: { cid: target.cid, removed: 1 } });
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);
  } finally {
    proceed.resolve();
    await holding;
    if (originalSignal === undefined) delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    else process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = originalSignal;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}, 15_000);

test("remove waiting behind deletion returns PROFILE_NOT_FOUND and never recreates the profile", async () => {
  const name = "doomed-grants";
  const target = await fixture.hermetic.mintDelegation();
  const original = JSON.parse(await readFile(profileConfigPath(fixture.profile), "utf8"));
  await writeJsonAtomic(profileConfigPath(name), { ...original, name });
  await writeJsonAtomic(additionalDelegationsPath(name), [bound(target)]);
  const signal = join(home, "grants-deleted-contended");
  const originalSignal = process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = signal;
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const deleting = ProfileManager.withLock(name, async () => {
    entered.resolve();
    await proceed.promise;
    await ProfileManager.deleteProfile(name);
  });
  try {
    await entered.promise;
    const removing = command(name, ["remove", target.cid]);
    while (!(await stat(signal).then(() => true, () => false))) { /* each stat yields to the waiting writer */ }
    proceed.resolve();
    await deleting;
    expect(await removing).toMatchObject({ code: 1, error: { error: { code: "PROFILE_NOT_FOUND" } } });
    await expect(stat(profileConfigPath(name))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(additionalDelegationsPath(name))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    proceed.resolve();
    await deleting;
    if (originalSignal === undefined) delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    else process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = originalSignal;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}, 15_000);
