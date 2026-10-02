import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfileLockTimeoutError,
  additionalDelegationsPath,
  authRequestsPath,
  profileConfigPath,
  profileLockMetadataPath,
  profileLockPath,
  profilePath,
  profileStoreMetadataPath,
  readAdditionalDelegations,
  readJson,
  readProfileStore,
  readSession,
  readStoreMetadata,
  removeSession,
  sessionPath,
  tinycloudConfigPath,
  tinycloudHomePath,
  updateProfileStore,
  upsertProfileRecord,
  withProfileLock,
  writeJsonAtomic,
  writeSession,
  withTinyCloudStateRoot,
} from "./state.js";
import { waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";
import { resolveInvocationContext } from "./profile.js";

const originalTcHome = process.env.TC_HOME;
const originalHome = process.env.HOME;
const originalNodeEnv = process.env.NODE_ENV;
const originalRecoveryBarrier = process.env.TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR;
const homes: string[] = [];

afterEach(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalRecoveryBarrier === undefined) delete process.env.TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR;
  else process.env.TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR = originalRecoveryBarrier;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-operations-state-"));
  homes.push(home);
  process.env.TC_HOME = home;
  process.env.HOME = homedir();
  return home;
}

function request(requestId: string, revision = 1): { requestId: string; revision: number } {
  return { requestId, revision };
}

const legacyProfile = {
  name: "legacy",
  host: "https://node.tinycloud.test",
  chainId: 1,
  spaceName: "default",
  did: "did:key:legacy#controller",
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("reads unversioned format-1 stores and writes format metadata without changing JSON layout", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profilePath(profile), { recursive: true });
  await writeFile(
    authRequestsPath(profile),
    '[\n  {\n    "requestId": "req-old",\n    "revision": 1\n  }\n]\n',
    "utf8",
  );

  expect(await readStoreMetadata(profile, "auth-requests")).toEqual({ formatVersion: 1 });
  expect(await readProfileStore<{ requestId: string; revision: number }>(profile, "auth-requests")).toEqual({
    formatVersion: 1,
    records: [request("req-old")],
  });

  await upsertProfileRecord(
    profile,
    "auth-requests",
    "req-new",
    request("req-new"),
    (candidate) => candidate.requestId,
  );

  expect(await readFile(authRequestsPath(profile), "utf8")).toBe(
    '[\n  {\n    "requestId": "req-old",\n    "revision": 1\n  },\n  {\n    "requestId": "req-new",\n    "revision": 1\n  }\n]\n',
  );
  expect(await readFile(profileStoreMetadataPath(profile, "auth-requests"), "utf8")).toBe(
    '{\n  "formatVersion": 1\n}\n',
  );
});

test("isolates concurrent operation state roots with the same profile name", async () => {
  const firstHome = await mkdtemp(join(tmpdir(), "tinycloud-operations-tenant-a-"));
  const secondHome = await mkdtemp(join(tmpdir(), "tinycloud-operations-tenant-b-"));
  homes.push(firstHome, secondHome);

  await Promise.all([
    withTinyCloudStateRoot(firstHome, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeSession("agent", { tenant: "a" });
    }),
    withTinyCloudStateRoot(secondHome, async () => {
      await writeSession("agent", { tenant: "b" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }),
  ]);

  expect(await withTinyCloudStateRoot(firstHome, () => readSession("agent"))).toEqual({ tenant: "a" });
  expect(await withTinyCloudStateRoot(secondHome, () => readSession("agent"))).toEqual({ tenant: "b" });
});

test("rejects an unsupported store format rather than silently downgrading it", async () => {
  await isolatedHome();
  const profile = "delegate";
  await writeJsonAtomic(profileStoreMetadataPath(profile, "session"), { formatVersion: 2 });

  await expect(readStoreMetadata(profile, "session")).rejects.toThrow(
    'Unsupported store format for "session".',
  );
  await expect(writeSession(profile, { verificationMethod: "did:key:session" })).rejects.toThrow(
    'Unsupported store format for "session".',
  );
  await expect(readFile(sessionPath(profile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("atomically appends records and replaces duplicate explicit keys", async () => {
  await isolatedHome();
  const profile = "delegate";

  await upsertProfileRecord(
    profile,
    "additional-delegations",
    "bafy-one",
    { delegation: { cid: "bafy-one" }, revision: 1 },
    (candidate) => candidate.delegation.cid,
  );
  await upsertProfileRecord(
    profile,
    "additional-delegations",
    "bafy-two",
    { delegation: { cid: "bafy-two" }, revision: 1 },
    (candidate) => candidate.delegation.cid,
  );
  await upsertProfileRecord(
    profile,
    "additional-delegations",
    "bafy-one",
    { delegation: { cid: "bafy-one" }, revision: 2 },
    (candidate) => candidate.delegation.cid,
  );

  const text = await readFile(additionalDelegationsPath(profile), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(await readAdditionalDelegations(profile)).toEqual([
    { delegation: { cid: "bafy-two" }, revision: 1 },
    { delegation: { cid: "bafy-one" }, revision: 2 },
  ]);
  expect(JSON.parse(text)).toEqual([
    { delegation: { cid: "bafy-two" }, revision: 1 },
    { delegation: { cid: "bafy-one" }, revision: 2 },
  ]);
});

test("updates a format-1 record store under the one profile lock without changing its legacy array layout", async () => {
  await isolatedHome();
  const profile = "delegate";
  await upsertProfileRecord(
    profile,
    "auth-requests",
    "req-old",
    request("req-old"),
    (candidate) => candidate.requestId,
  );

  const count = await updateProfileStore(
    profile,
    "auth-requests",
    (records: readonly { requestId: string; revision: number }[]) => ({
      records: [...records, request("req-new")],
      result: records.length + 1,
    }),
  );

  expect(count).toBe(2);
  expect(await readFile(authRequestsPath(profile), "utf8")).toBe(
    '[\n  {\n    "requestId": "req-old",\n    "revision": 1\n  },\n  {\n    "requestId": "req-new",\n    "revision": 1\n  }\n]\n',
  );
});

test("writes and removes sessions under the profile lock with legacy JSON bytes", async () => {
  await isolatedHome();
  const profile = "delegate";
  await writeSession(profile, { authMethod: "openkey", verificationMethod: "did:key:session" });

  expect(await readFile(sessionPath(profile), "utf8")).toBe(
    '{\n  "authMethod": "openkey",\n  "verificationMethod": "did:key:session"\n}\n',
  );
  expect(await readSession(profile)).toEqual({
    authMethod: "openkey",
    verificationMethod: "did:key:session",
  });
  expect(await readStoreMetadata(profile, "session")).toEqual({ formatVersion: 1 });

  await removeSession(profile);
  await expect(readFile(sessionPath(profile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("recovers a stale profile lock only after its owner is gone", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(profile), {
    pid: 999_999_999,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await upsertProfileRecord(
    profile,
    "auth-requests",
    "req-stale",
    request("req-stale"),
    (candidate) => candidate.requestId,
    { staleAfterMs: 1, retryMs: 1 },
  );

  expect((await readProfileStore<{ requestId: string; revision: number }>(profile, "auth-requests")).records)
    .toEqual([request("req-stale")]);
  await expect(readFile(profileLockMetadataPath(profile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("two contenders recover one crashed stale lock without deleting the live replacement", async () => {
  const home = await isolatedHome();
  const profile = "delegate";
  const barrier = join(home, "recovery-barrier");
  await mkdir(barrier, { recursive: true });
  await mkdir(profileLockPath(profile), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(profile), {
    pid: 999_999_999,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    token: "crashed-holder",
  });
  process.env.NODE_ENV = "test";
  process.env.TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR = barrier;

  const fixture = new URL("../test-support/append-profile-record.ts", import.meta.url).pathname;
  const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  const first = Bun.spawn([
    process.execPath,
    fixture,
    profile,
    "req-first-recovery",
    JSON.stringify(request("req-first-recovery")),
  ], { env, stdout: "pipe", stderr: "pipe" });
  const second = Bun.spawn([
    process.execPath,
    fixture,
    profile,
    "req-second-recovery",
    JSON.stringify(request("req-second-recovery")),
  ], { env, stdout: "pipe", stderr: "pipe" });

  await waitForProfileLockProtocol(
    join(barrier, `ready-${first.pid}-${profile}`),
    "first stale-lock contender",
  );
  await waitForProfileLockProtocol(
    join(barrier, `ready-${second.pid}-${profile}`),
    "second stale-lock contender",
  );
  await writeFile(join(barrier, "release"), "release\n", "utf8");

  const [firstExit, secondExit, firstError, secondError] = await Promise.all([
    first.exited,
    second.exited,
    new Response(first.stderr).text(),
    new Response(second.stderr).text(),
  ]);
  expect(firstExit, firstError).toBe(0);
  expect(secondExit, secondError).toBe(0);
  expect((await readdir(profileLockPath(profile)).catch(() => [])).filter((name) => name.startsWith(".stale-"))).toEqual([]);
  expect((await readProfileStore<{ requestId: string; revision: number }>(profile, "auth-requests")).records
    .map((record) => record.requestId).sort()).toEqual(["req-first-recovery", "req-second-recovery"]);
});

test("a completed holder cannot release a replacement lock instance", async () => {
  await isolatedHome();
  const profile = "delegate";
  await withProfileLock(profile, async () => {
    await rm(profileLockPath(profile), { recursive: true, force: true });
    await mkdir(profileLockPath(profile), { recursive: true });
    await writeJsonAtomic(profileLockMetadataPath(profile), {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      token: "replacement-instance",
    });
  });

  expect(await readJson<{ pid?: number; createdAt?: string; token?: string }>(profileLockMetadataPath(profile))).toEqual({
    pid: process.pid,
    createdAt: expect.any(String),
    token: "replacement-instance",
  });
});

test("times out rather than reclaiming a lock held by a live process", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(profile), {
    pid: process.pid,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await expect(upsertProfileRecord(
    profile,
    "auth-requests",
    "req-timeout",
    request("req-timeout"),
    (candidate) => candidate.requestId,
    { timeoutMs: 30, retryMs: 2, staleAfterMs: 1 },
  )).rejects.toBeInstanceOf(ProfileLockTimeoutError);
});

test("waits rather than reclaiming an ownerless lock younger than the stale threshold", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });

  // A live acquirer may be between mkdir and publishing its owner file.
  await expect(upsertProfileRecord(
    profile,
    "auth-requests",
    "req-ownerless-timeout",
    request("req-ownerless-timeout"),
    (candidate) => candidate.requestId,
    { timeoutMs: 30, retryMs: 2, staleAfterMs: 60_000 },
  )).rejects.toBeInstanceOf(ProfileLockTimeoutError);
});

test("a delayed ownerless reclaim cannot remove the lock another process reclaimed and now holds", async () => {
  const home = await isolatedHome();
  const profile = "delegate";
  const barrier = join(home, "ownerless-barrier");
  const holders = join(home, "holders");
  await mkdir(holders, { recursive: true });
  await mkdir(barrier, { recursive: true });
  // An ownerless lock left by an older release or a crash, a minute old.
  await mkdir(profileLockPath(profile), { recursive: true });
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(profileLockPath(profile), aMinuteAgo, aMinuteAgo);

  const fixture = new URL("../test-support/hold-profile-lock.ts", import.meta.url).pathname;
  const baseEnv: Record<string, string | undefined> = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  delete baseEnv.TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR;
  // C sees the aged empty lock and stops just before its rmdir.
  const late = Bun.spawn([process.execPath, fixture, profile, holders, join(home, "late-ready"), "-", "2000", "30000"], {
    env: { ...baseEnv, TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR: barrier },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForProfileLockProtocol(join(barrier, `ready-${late.pid}-${profile}`), "the late reclaimer at its rmdir");

  // B reclaims the same directory, acquires, and holds the lock.
  const holder = Bun.spawn([process.execPath, fixture, profile, holders, join(home, "holder-ready"), join(home, "holder-release"), "10000", "30000"], {
    env: baseEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForProfileLockProtocol(join(home, "holder-ready"), "the reclaiming holder");

  // C now runs its rmdir against B's lock.
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  const [lateExit, lateError] = await Promise.all([late.exited, new Response(late.stderr).text()]);
  expect(lateExit, lateError).toBe(3);
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: holder.pid });

  await writeFile(join(home, "holder-release"), "release\n", "utf8");
  const [holderExit, holderError] = await Promise.all([holder.exited, new Response(holder.stderr).text()]);
  expect(holderExit, holderError).toBe(0);
  expect((await readdir(holders)).filter((name) => name.startsWith("violation-"))).toEqual([]);
}, 30_000);

test("reclaims an ownerless lock directory older than the stale threshold", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  // The holder crashed between mkdir and publishing its owner file a minute ago.
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(profileLockPath(profile), aMinuteAgo, aMinuteAgo);

  const records = await upsertProfileRecord(
    profile,
    "auth-requests",
    "req-ownerless-reclaimed",
    request("req-ownerless-reclaimed"),
    (candidate) => candidate.requestId,
    { timeoutMs: 1_000, retryMs: 2, staleAfterMs: 30_000 },
  );
  expect(records.map((record) => record.requestId)).toEqual(["req-ownerless-reclaimed"]);
});

test("lock ownership ends with the critical section: deferred work waits for the lock", async () => {
  await isolatedHome();
  const profile = "delegate";
  const deferredStart = Promise.withResolvers<void>();
  let deferred: Promise<string> | undefined;
  await withProfileLock(profile, async () => {
    // Started inside the section, runs after it returned.
    deferred = deferredStart.promise.then(() => withProfileLock(profile, async () => "entered", { timeoutMs: 50, retryMs: 2 }));
  });
  const holderReleased = Promise.withResolvers<void>();
  const holding = withProfileLock(profile, async () => {
    deferredStart.resolve();
    await deferred!.catch(() => undefined);
    holderReleased.resolve();
  });
  await expect(deferred!).rejects.toBeInstanceOf(ProfileLockTimeoutError);
  await holderReleased.promise;
  await holding;
});

test("a lock held in one state root does not stand in for another root's lock", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "tc-lock-root-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "tc-lock-root-b-"));
  try {
    const innerLockSeen = await withTinyCloudStateRoot(rootA, () => withProfileLock("delegate", () =>
      withTinyCloudStateRoot(rootB, () => withProfileLock("delegate", () =>
        stat(profileLockPath("delegate")).then(() => true, () => false)))));
    expect(innerLockSeen).toBe(true);
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("two child processes append distinct records without losing either update", async () => {
  const home = await isolatedHome();
  const fixture = new URL("../test-support/append-profile-record.ts", import.meta.url).pathname;
  const env = { ...process.env, TC_HOME: home, HOME: homedir() };
  const first = Bun.spawn([
    process.execPath,
    fixture,
    "delegate",
    "req-first",
    JSON.stringify(request("req-first")),
  ], { env, stdout: "pipe", stderr: "pipe" });
  const second = Bun.spawn([
    process.execPath,
    fixture,
    "delegate",
    "req-second",
    JSON.stringify(request("req-second")),
  ], { env, stdout: "pipe", stderr: "pipe" });
  const [firstExit, secondExit, firstError, secondError] = await Promise.all([
    first.exited,
    second.exited,
    new Response(first.stderr).text(),
    new Response(second.stderr).text(),
  ]);

  expect(firstExit, firstError).toBe(0);
  expect(secondExit, secondError).toBe(0);
  const records = (await readProfileStore<{ requestId: string; revision: number }>(
    "delegate",
    "auth-requests",
  )).records.sort((left, right) => left.requestId.localeCompare(right.requestId));
  expect(records).toEqual([request("req-first"), request("req-second")]);
});

test("uses TC_HOME as a home root and never resolves test state from the developer home", async () => {
  const home = await isolatedHome();
  await writeSession("isolated", { value: "only-in-test-home" });

  expect(tinycloudHomePath()).toBe(join(home, ".tinycloud"));
  expect(profilePath("isolated").startsWith(join(homedir(), ".tinycloud"))).toBe(false);
  expect(await readFile(sessionPath("isolated"), "utf8")).toContain("only-in-test-home");
});

test("returns PROFILE_NOT_FOUND for a deleted pinned profile and never falls back", async () => {
  await isolatedHome();
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "fallback", version: 1 });
  await writeJsonAtomic(profileConfigPath("fallback"), {
    host: "https://fallback.tinycloud.test",
    did: "did:key:fallback",
  });

  const result = await resolveInvocationContext({ profile: "deleted" });

  expect(result).toEqual({
    ok: false,
    error: {
      code: "PROFILE_NOT_FOUND",
      message: 'Profile "deleted" is not available.',
      retryable: false,
    },
  });
});

for (const [name, contents] of [
  ["an array", []],
  ["an empty object", {}],
  ["a profile without a name", (() => {
    const { name: _name, ...profile } = legacyProfile;
    return profile;
  })()],
  ["a profile without a DID", (() => {
    const { did: _did, ...profile } = legacyProfile;
    return profile;
  })()],
  ["a profile with a non-string host", { ...legacyProfile, host: 42 }],
  ["a profile with a non-numeric chain ID", { ...legacyProfile, chainId: "1" }],
  ["a profile with a non-string space name", { ...legacyProfile, spaceName: {} }],
  ["a profile without its creation time", (() => {
    const { createdAt: _createdAt, ...profile } = legacyProfile;
    return profile;
  })()],
  ["a profile with an invalid session DID", { ...legacyProfile, sessionDid: [] }],
  ["a profile with an invalid posture", { ...legacyProfile, posture: "not-a-posture" }],
  ["a profile with an invalid operator type", { ...legacyProfile, operatorType: "robot" }],
  ["a profile with an invalid auth method", { ...legacyProfile, authMethod: "password" }],
  ["a delegate profile with local owner authentication", {
    ...legacyProfile,
    posture: "delegate-session",
    authMethod: "local",
    privateKey: "1".padStart(64, "0"),
  }],
] as const) {
  test(`returns PROFILE_NOT_FOUND instead of an owner context for ${name}`, async () => {
    await isolatedHome();
    const profile = "malformed";
    await writeJsonAtomic(profileConfigPath(profile), contents);

    expect(await resolveInvocationContext({ profile })).toEqual({
      ok: false,
      error: {
        code: "PROFILE_NOT_FOUND",
        message: `Profile "${profile}" is not available.`,
        retryable: false,
      },
    });
  });
}

test("accepts the legacy required profile shape without newer posture fields", async () => {
  await isolatedHome();
  await writeJsonAtomic(profileConfigPath("legacy"), legacyProfile);

  expect(await resolveInvocationContext({
    profile: "legacy",
    host: "https://override.tinycloud.test",
  })).toEqual({
    ok: true,
    context: {
      profile: "legacy",
      host: "https://override.tinycloud.test",
      posture: "owner-openkey",
      operatorType: "human",
      principalDid: "did:key:legacy",
      sessionDid: undefined,
      ownerDid: undefined,
      space: undefined,
    },
  });
});

test("preserves the local-owner posture for a valid profile", async () => {
  await isolatedHome();
  await writeJsonAtomic(profileConfigPath("local"), {
    ...legacyProfile,
    name: "local",
    authMethod: "local",
  });

  expect(await resolveInvocationContext({ profile: "local" })).toMatchObject({
    ok: true,
    context: {
      profile: "local",
      posture: "local-owner-key",
    },
  });
});

test("returns safe profile identity without profile or invocation private-key material", async () => {
  await isolatedHome();
  await writeJsonAtomic(profileConfigPath("delegate"), {
    ...legacyProfile,
    name: "delegate",
    host: "https://node.tinycloud.test",
    did: "did:pkh:eip155:1:0xowner#controller",
    sessionDid: "did:key:session#key-1",
    ownerDid: "did:pkh:eip155:1:0xowner#owner",
    spaceId: "tinycloud:pkh:eip155:1:0xowner:secrets",
    posture: "delegate-session",
    operatorType: "agent",
    privateKey: "profile-private-key-canary",
  });

  const result = await resolveInvocationContext({
    profile: "delegate",
    privateKey: "invocation-private-key-canary",
  });

  expect(result).toEqual({
    ok: true,
    context: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      operatorType: "agent",
      principalDid: "did:pkh:eip155:1:0xowner",
      sessionDid: "did:key:session",
      ownerDid: "did:pkh:eip155:1:0xowner",
      space: "tinycloud:pkh:eip155:1:0xowner:secrets",
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-key-canary");
});
