import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TinyCloudNode } from "@tinycloud/node-sdk";

import type { OperationResult } from "../contract.js";
import type { OperationError } from "../errors.js";
import { bindingMigrationPath, bindingMigrationRecorded } from "../delegation-binding.js";
import { invokeOperation } from "../invoke.js";
import {
  additionalDelegationsPath,
  profileConfigPath,
  profilePath,
  readAdditionalDelegations,
  sessionPath,
  writeJsonAtomic,
} from "../state.js";
import {
  createAuthRuntimeFixture,
  persistRuntimeDelegations,
  type AuthRuntimeFixture,
  type StoredRuntimeDelegation,
} from "../../test-support/auth-runtime.js";

const CANARY = "HERMETIC_DELEGATION_CANARY";

let home: string;
let fixture: AuthRuntimeFixture | undefined;

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-secrets-status-hermetic-`);
  process.env.TC_HOME = home;
});

afterEach(async () => {
  fixture?.hermetic.stop();
  fixture = undefined;
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

/** Every entry under TC_HOME: relative path, kind, size, sha256 and mtime (the profile-locks tree included). */
async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (entry.isDirectory()) {
        entries.push(`dir ${relative(root, path)} ${stats.mtimeMs}`);
        await walk(path);
      } else {
        const sha256 = entry.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "-";
        entries.push(`file ${relative(root, path)} ${stats.size} ${sha256} ${stats.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return entries;
}

async function writeProfile(name: string, profile: Record<string, unknown>, session?: unknown): Promise<void> {
  await writeJsonAtomic(profileConfigPath(name), {
    name,
    spaceName: "secrets",
    createdAt: "2026-07-15T00:00:00.000Z",
    ...profile,
  });
  if (session !== undefined) await writeJsonAtomic(sessionPath(name), session);
}

/** An owner-openkey profile holding the owner's stored session; `privateKey` makes it the hybrid profile. */
async function writeOwnerProfile(current: AuthRuntimeFixture, name: string, privateKey?: string): Promise<void> {
  const session = current.hermetic.ownerRestorableSession;
  await writeProfile(name, {
    host: current.hermetic.host,
    chainId: session.chainId,
    spaceId: session.spaceId,
    did: current.hermetic.ownerDid,
    sessionDid: session.verificationMethod.split("#", 1)[0],
    posture: "owner-openkey",
    operatorType: "human",
    authMethod: "openkey",
    ...(privateKey === undefined ? {} : { privateKey }),
  }, session);
}

/** A grant bound to its request, as `tc auth grant` / `tinycloud.auth.import` store it. */
async function persistCliGrant(name: string, current: AuthRuntimeFixture, delegation: StoredRuntimeDelegation): Promise<void> {
  await writeJsonAtomic(additionalDelegationsPath(name), [{
    delegation,
    permissions: [],
    authorityRequest: { requestId: "req_cli_grant", requested: current.hermetic.permissions },
    authorityRequestAudit: { source: "cli-grant", recordedAt: "2026-07-15T00:00:00.000Z", note: "fixture" },
  }]);
}

async function storedAuthorizationHashes(names: readonly string[]): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const name of names) {
    for (const record of await readAdditionalDelegations<{ delegation?: { delegationHeader?: { Authorization?: string } } }>(name)) {
      const authorization = record.delegation?.delegationHeader?.Authorization;
      if (typeof authorization === "string") hashes.add(createHash("sha256").update(authorization).digest("hex"));
    }
  }
  return hashes;
}

function status(profile: string, target: Record<string, unknown> = {}) {
  return invokeOperation("tinycloud.secrets.status", 1, { profile, ...target }, { names: [CANARY] });
}

/** Runs one status invocation and checks the remote-write and TC_HOME invariants (S2-T6, S2-T7). */
async function assertReadOnlyStatus(
  current: AuthRuntimeFixture,
  profile: string,
  target: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof status>>> {
  const allowedDelegations = await storedAuthorizationHashes([profile]);
  const before = await snapshot(home);
  const requestStart = current.hermetic.requests().length;
  const invocationStart = current.hermetic.invocations().length;

  const result = await status(profile, target);

  expect(await snapshot(home)).toEqual(before);
  const requests = current.hermetic.requests().slice(requestStart);
  const invocations = current.hermetic.invocations().slice(invocationStart);
  expect(invocations.length).toBeGreaterThan(0);
  for (const invocation of invocations) {
    expect(invocation.action).toBe("tinycloud.kv/get");
    expect(invocation.service).toBe("kv");
    expect(invocation.space.endsWith(":secrets")).toBe(true);
  }
  for (const request of requests) {
    expect(request.method).toBe("POST");
    if (request.path === "/delegate") {
      expect(allowedDelegations.has(request.authorizationSha256 ?? "")).toBe(true);
    } else {
      expect(request.path).toBe("/invoke");
    }
  }
  expect(requests.some((request) => request.path.startsWith("/peer/generate"))).toBe(false);
  expect(requests.some((request) => request.path.startsWith("/encryption/"))).toBe(false);
  return result;
}

async function assertZeroRequests(
  current: AuthRuntimeFixture,
  profile: string,
  target: Record<string, unknown>,
  code: string,
): Promise<Awaited<ReturnType<typeof status>>> {
  const before = await snapshot(home);
  const requestStart = current.hermetic.requests().length;
  const result = await status(profile, target);
  expect(result).toMatchObject({ status: "error", error: { code } });
  expect(current.hermetic.requests().slice(requestStart)).toEqual([]);
  expect(await snapshot(home)).toEqual(before);
  return result;
}

test("S2-T6/S2-T7 delegate-session: only kv/get invocations and stored-grant re-registration, TC_HOME unchanged", async () => {
  fixture = await createAuthRuntimeFixture();
  await persistRuntimeDelegations(fixture, [await fixture.hermetic.mintDelegation()]);
  const result = await assertReadOnlyStatus(fixture, fixture.profile);
  expect(result).toMatchObject({
    status: "ok",
    output: { status: "ready", owner: fixture.hermetic.ownerDid, present: [CANARY], pending: [], denied: [] },
  });
  expect(fixture.hermetic.requests().filter((request) => request.path === "/delegate").length).toBeGreaterThan(0);
});

test("S2-T6/S2-T7 owner-openkey with a stored session and a stored cli-grant", async () => {
  fixture = await createAuthRuntimeFixture();
  await writeOwnerProfile(fixture, "openkey-owner");
  const audience = fixture.hermetic.ownerRestorableSession.verificationMethod.split("#", 1)[0]!;
  await persistCliGrant("openkey-owner", fixture, await fixture.hermetic.mintDelegationForAudience(audience));
  const result = await assertReadOnlyStatus(fixture, "openkey-owner", { allowOwnerProfile: true });
  expect(result).toMatchObject({ status: "ok", output: { owner: fixture.hermetic.ownerDid, names: [CANARY] } });
});

test("S2-T6/S2-T7 local-owner-key with a stored session", async () => {
  fixture = await createAuthRuntimeFixture();
  await fixture.hermetic.mintDelegation();
  const result = await assertReadOnlyStatus(fixture, fixture.ownerProfile, { allowOwnerProfile: true });
  expect(result).toMatchObject({ status: "ok", output: { owner: fixture.hermetic.ownerDid, names: [CANARY] } });
});

test("S2-T6/S2-T7 hybrid privateKey + OpenKey profile with a session", async () => {
  fixture = await createAuthRuntimeFixture();
  await fixture.hermetic.mintDelegation();
  await writeOwnerProfile(fixture, "hybrid", fixture.hermetic.ownerPrivateKey);
  const result = await assertReadOnlyStatus(fixture, "hybrid", { allowOwnerProfile: true });
  expect(result).toMatchObject({ status: "ok", output: { owner: fixture.hermetic.ownerDid, names: [CANARY] } });
  // A local identity never gets a request link (the hint case is in secrets-status.test.ts).
  expect(JSON.stringify(result)).not.toContain("secrets.tinycloud.xyz");
});

test("S2-T6/S2-T7 zero requests: local owner without a session, an explicit key, a pending migration", async () => {
  fixture = await createAuthRuntimeFixture();

  await rm(sessionPath(fixture.ownerProfile));
  const noSession = await assertZeroRequests(fixture, fixture.ownerProfile, { allowOwnerProfile: true }, "SESSION_NOT_FOUND");
  expect(noSession).toMatchObject({
    error: { details: { recovery: { action: "sign_in", command: "tc --profile owner auth login --method local" } } },
  });

  const explicit = await assertZeroRequests(fixture, fixture.profile, { privateKey: fixture.hermetic.ownerPrivateKey }, "AUTH_REQUIRED");
  expect(errorOf(explicit).details).toEqual({ reason: "explicit_key" });

  const delegation = await fixture.hermetic.mintDelegation();
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);
  const requestStart = fixture.hermetic.requests().length;
  const pending = await assertZeroRequests(fixture, fixture.profile, {}, "PROFILE_MIGRATION_REQUIRED");
  expect(fixture.hermetic.requests().slice(requestStart)).toEqual([]);
  expect(errorOf(pending).details).toEqual({
    recovery: { action: "complete_migration", command: "tc --profile delegate auth caps", operationId: "tinycloud.auth.capabilities" },
  });
  expect(await bindingMigrationRecorded(fixture.profile)).toBe(false);
});

test("S2-T7 a migration marker, or no unbound compact record, lets status proceed", async () => {
  fixture = await createAuthRuntimeFixture();
  const delegation = await fixture.hermetic.mintDelegation();

  // Bound records only, no marker: nothing for the migration to bind.
  await persistRuntimeDelegations(fixture, [delegation]);
  expect(await bindingMigrationRecorded(fixture.profile)).toBe(false);
  expect(await assertReadOnlyStatus(fixture, fixture.profile)).toMatchObject({ status: "ok", output: { status: "ready" } });
  expect(await bindingMigrationRecorded(fixture.profile)).toBe(false);

  // An unbound record after the migration is refused by replay, never migrated here.
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);
  await writeJsonAtomic(bindingMigrationPath(fixture.profile), { formatVersion: 1, migratedAt: "2026-07-15T00:00:00.000Z", bound: [], unbound: [] });
  const result = await assertReadOnlyStatus(fixture, fixture.profile);
  expect(result).toMatchObject({ status: "ok", warnings: [{ code: "STORED_GRANT_SKIPPED", reason: "unbound" }] });
});

test("S2-T9 every restored-runtime sign-in error carries the posture's persistent login", async () => {
  fixture = await createAuthRuntimeFixture();
  await fixture.hermetic.mintDelegation();
  await writeOwnerProfile(fixture, "openkey-owner");
  const cases = [
    [fixture.profile, "tc --profile delegate auth login --method openkey --paste --manifest <manifest.json>"],
    ["openkey-owner", "tc --profile openkey-owner auth login --method openkey"],
    [fixture.ownerProfile, "tc --profile owner auth login --method local"],
  ] as const;
  const recovery = (command: string) => ({ recovery: { action: "sign_in", command } });

  const expired = spyOn(TinyCloudNode.prototype, "restoreSession").mockImplementation(async () => {
    throw Object.assign(new Error("expired"), { code: "AUTH_EXPIRED" });
  });
  try {
    for (const [profile, command] of cases) {
      const result = await status(profile, { allowOwnerProfile: true });
      expect(result).toMatchObject({ status: "error", error: { code: "AUTH_REQUIRED", retryable: false } });
      expect(errorOf(result).details).toEqual(recovery(command));
    }
  } finally {
    expired.mockRestore();
  }

  const plain401 = spyOn(TinyCloudNode.prototype, "kvForSpace").mockImplementation(() => ({
    get: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED", service: "kv", meta: { status: 401 } } }),
  }) as never);
  try {
    for (const [profile, command] of cases) {
      const result = await status(profile, { allowOwnerProfile: true });
      expect(result).toMatchObject({ status: "error", error: { code: "AUTH_REQUIRED" } });
      expect(errorOf(result).details).toEqual(recovery(command));
    }
  } finally {
    plain401.mockRestore();
  }

  for (const [profile, command] of cases) {
    await rm(sessionPath(profile));
    const result = await status(profile, { allowOwnerProfile: true });
    expect(result).toMatchObject({ status: "error", error: { code: "SESSION_NOT_FOUND" } });
    expect(errorOf(result).details).toEqual(recovery(command));
  }
});

test("S2-T9 the migration recovery is proven: auth.capabilities migrates, then status proceeds", async () => {
  fixture = await createAuthRuntimeFixture();
  const delegation = await fixture.hermetic.mintDelegation();
  await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);

  expect(await status(fixture.profile)).toMatchObject({
    status: "error",
    error: {
      code: "PROFILE_MIGRATION_REQUIRED",
      details: { recovery: { action: "complete_migration", command: "tc --profile delegate auth caps", operationId: "tinycloud.auth.capabilities" } },
    },
  });
  expect(await bindingMigrationRecorded(fixture.profile)).toBe(false);

  expect(await invokeOperation("tinycloud.auth.capabilities", 1, { profile: fixture.profile }, {}))
    .toMatchObject({ status: "ok" });
  expect(await bindingMigrationRecorded(fixture.profile)).toBe(true);
  expect(await readFile(join(profilePath(fixture.profile), "delegation-binding-migration.json"), "utf8")).toContain(delegation.cid);

  expect(await status(fixture.profile)).toMatchObject({ status: "ok", output: { status: "ready", present: [CANARY] } });
});

/** The error of an error envelope; any other envelope fails the test. */
function errorOf(result: OperationResult<unknown>): OperationError {
  if (result.status !== "error") throw new Error(`expected an error envelope, got ${result.status}`);
  return result.error;
}
