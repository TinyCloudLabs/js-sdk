import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
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

const holdFixture = new URL("../test-support/hold-profile-lock.ts", import.meta.url).pathname;
const cycleFixture = new URL("../test-support/cycle-profile-lock.ts", import.meta.url).pathname;
const LOCK_BARRIERS = ["OWNERLESS", "PUBLISH", "RELEASE", "RECOVERY", "CLAIM"].map((name) => `TC_TEST_PROFILE_LOCK_${name}_BARRIER_DIR`);

/** Environment for a lock child process: this test's TC_HOME, no inherited barriers. */
function lockChildEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  for (const name of [...LOCK_BARRIERS, "TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH"]) delete env[name];
  return { ...env, ...extra };
}

interface LockHolder {
  readonly pid: number;
  readonly readyPath: string;
  release(): Promise<void>;
  kill(): void;
  finished(): Promise<[number, string]>;
}

/**
 * A child that takes the lock once (hold-profile-lock.ts), signals `<name>-ready`
 * and holds until released. Exit 3 means it timed out without holding.
 */
function spawnLockHolder(home: string, holders: string, profile: string, name: string, options: { timeoutMs: number; staleAfterMs: number; holdUntilReleased?: boolean; env?: Record<string, string> }): LockHolder {
  const readyPath = join(home, `${name}-ready`);
  const releasePath = join(home, `${name}-release`);
  const child = Bun.spawn([process.execPath, holdFixture, profile, holders, readyPath, options.holdUntilReleased === false ? "-" : releasePath, String(options.timeoutMs), String(options.staleAfterMs)], {
    env: lockChildEnv(home, options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    pid: child.pid,
    readyPath,
    release: () => writeFile(releasePath, "release\n", "utf8"),
    kill: () => child.kill("SIGKILL"),
    finished: async () => {
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return [exit, stderr];
    },
  };
}

async function violations(holders: string): Promise<string[]> {
  return (await readdir(holders)).filter((name) => name.startsWith("violation-"));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function ageLock(profile: string): Promise<void> {
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(profileLockPath(profile), aMinuteAgo, aMinuteAgo);
}

async function lockTestHome(): Promise<{ home: string; holders: string }> {
  const home = await isolatedHome();
  const holders = join(home, "holders");
  await mkdir(holders, { recursive: true });
  return { home, holders };
}

test("a delayed ownerless reclaim cannot remove the lock another process reclaimed and now holds", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const barrier = join(home, "ownerless-barrier");
  await mkdir(barrier, { recursive: true });
  // An ownerless lock left by an older release or a crash, a minute old.
  await mkdir(profileLockPath(profile), { recursive: true });
  await ageLock(profile);

  // C sees the aged empty lock and stops just before its rmdir.
  const late = spawnLockHolder(home, holders, profile, "late", { timeoutMs: 2000, staleAfterMs: 30_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${late.pid}-${profile}`), "the late reclaimer at its rmdir");

  // B reclaims the same directory, acquires, and holds the lock.
  const holder = spawnLockHolder(home, holders, profile, "holder", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(holder.readyPath, "the reclaiming holder");

  // C now runs its rmdir against B's lock.
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  const [lateExit, lateError] = await late.finished();
  expect(lateExit, lateError).toBe(3);
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: holder.pid });

  await holder.release();
  const [holderExit, holderError] = await holder.finished();
  expect(holderExit, holderError).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 30_000);

test("an older release's lock, created but not yet owned, excludes this release and vice versa", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const lockPath = profileLockPath(profile);
  await mkdir(profilePath(profile), { recursive: true });

  // 842377d4-style writer: mkdir(.lock), paused before writing owner.json.
  await mkdir(lockPath);
  const contended = join(home, "contended");
  const contender = spawnLockHolder(home, holders, profile, "contender", { timeoutMs: 10_000, staleAfterMs: 30_000, env: { TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended } });
  await waitForProfileLockProtocol(contended, "the contender finding the older release's lock");
  // The older writer resumes: writes its owner record (writeJsonAtomic, as it
  // did) and enters its critical section. The contender never replaced it.
  await writeJsonAtomic(profileLockMetadataPath(profile), { pid: process.pid, createdAt: new Date().toISOString(), token: "older-release" });
  await writeFile(join(holders, "active"), "older-release\n", { encoding: "utf8", flag: "wx" });
  expect(await exists(contender.readyPath)).toBe(false);
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ token: "older-release" });
  // ...and releases the way it did.
  await rm(join(holders, "active"));
  await rm(profileLockMetadataPath(profile));
  await rmdir(lockPath);
  await waitForProfileLockProtocol(contender.readyPath, "the contender acquiring after the older release");

  // This release holding, the older writer's mkdir is refused.
  await expect(mkdir(lockPath)).rejects.toMatchObject({ code: "EEXIST" });
  await contender.release();
  const [exit, stderr] = await contender.finished();
  expect(exit, stderr).toBe(0);

  // A lock this release created but has not yet published excludes it too.
  const barrier = join(home, "publish-barrier");
  await mkdir(barrier);
  const publishing = spawnLockHolder(home, holders, profile, "publishing", { timeoutMs: 10_000, staleAfterMs: 30_000, env: { TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${publishing.pid}-${profile}`), "the writer between mkdir and link");
  await expect(mkdir(lockPath)).rejects.toMatchObject({ code: "EEXIST" });
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(publishing.readyPath, "the writer publishing its owner");
  await publishing.release();
  const [publishingExit, publishingError] = await publishing.finished();
  expect(publishingExit, publishingError).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 30_000);

test("a writer whose unpublished lock was reclaimed and taken over does not enter", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const barrier = join(home, "publish-barrier");
  await mkdir(barrier, { recursive: true });

  // B creates `.lock` and stops before linking its owner record.
  const contended = join(home, "b-contended");
  const slow = spawnLockHolder(home, holders, profile, "slow", { timeoutMs: 10_000, staleAfterMs: 30_000, env: { TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR: barrier, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended } });
  await waitForProfileLockProtocol(join(barrier, `ready-${slow.pid}-${profile}`), "B between mkdir and link");
  // B's empty lock looks abandoned; C reclaims it and takes the lock.
  await ageLock(profile);
  const fast = spawnLockHolder(home, holders, profile, "fast", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(fast.readyPath, "C holding the reclaimed lock");

  // B resumes: its link finds C's owner record, so it holds nothing and waits.
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(contended, "B's link refused");
  expect(await exists(slow.readyPath)).toBe(false);
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: fast.pid });

  await fast.release();
  const [fastExit, fastError] = await fast.finished();
  expect(fastExit, fastError).toBe(0);
  await waitForProfileLockProtocol(slow.readyPath, "B acquiring after C");
  await slow.release();
  const [slowExit, slowError] = await slow.finished();
  expect(slowExit, slowError).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 30_000);

test("a releasing holder's rmdir cannot hand the lock to two writers", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const releaseBarrier = join(home, "release-barrier");
  const publishBarrier = join(home, "publish-barrier");
  await mkdir(releaseBarrier, { recursive: true });
  await mkdir(publishBarrier, { recursive: true });

  // H takes the lock and stops mid-release, with `.lock` empty.
  const releasing = spawnLockHolder(home, holders, profile, "releasing", { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_RELEASE_BARRIER_DIR: releaseBarrier } });
  await waitForProfileLockProtocol(join(releaseBarrier, `ready-${releasing.pid}-${profile}`), "H between owner removal and rmdir");
  expect(await readdir(profileLockPath(profile))).toEqual([]);

  // C reclaims the empty directory, creates its own and stops before linking.
  await ageLock(profile);
  const contender = spawnLockHolder(home, holders, profile, "contender", { timeoutMs: 10_000, staleAfterMs: 30_000, env: { TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR: publishBarrier } });
  await waitForProfileLockProtocol(join(publishBarrier, `ready-${contender.pid}-${profile}`), "C between mkdir and link");

  // H's delayed rmdir removes C's still-empty directory...
  await writeFile(join(releaseBarrier, "release"), "release\n", "utf8");
  const [releasingExit, releasingError] = await releasing.finished();
  expect(releasingExit, releasingError).toBe(0);
  expect(await exists(profileLockPath(profile))).toBe(false);

  // ...so C's link fails with ENOENT; C holds nothing, retries and then holds.
  await writeFile(join(publishBarrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(contender.readyPath, "C acquiring after its retry");
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: contender.pid });
  await contender.release();
  const [contenderExit, contenderError] = await contender.finished();
  expect(contenderExit, contenderError).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 30_000);

test("a holder killed after claiming its owner record leaves a lock the next writer reclaims once aged", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const lockPath = profileLockPath(profile);
  const barrier = join(home, "claim-barrier");
  await mkdir(barrier, { recursive: true });

  // H releases: renames owner.json to its `.release-*` claim, then is killed.
  const killed = spawnLockHolder(home, holders, profile, "killed", { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_CLAIM_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${killed.pid}-${profile}`), "H holding its claimed owner record");
  killed.kill();
  await killed.finished();
  const left = await readdir(lockPath);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatch(/^\.release-[0-9a-f-]+\.json$/);
  // A crashed acquirer's staged owner file, long abandoned.
  const staged = join(profilePath(profile), `.lock-owner-${randomUUID()}.tmp`);
  await writeFile(staged, "{}\n", "utf8");
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(staged, aMinuteAgo, aMinuteAgo);

  // While the claim is fresh the lock is not reclaimed...
  await expect(withProfileLock(profile, async () => undefined, { timeoutMs: 200, staleAfterMs: 30_000, retryMs: 5 }))
    .rejects.toBeInstanceOf(ProfileLockTimeoutError);
  // ...once aged, the next writer removes the claim, the directory and the staged file.
  await ageLock(profile);
  const next = spawnLockHolder(home, holders, profile, "next", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(next.readyPath, "the next writer reclaiming");
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: next.pid });
  expect(await exists(staged)).toBe(false);
  await next.release();
  const [exit, stderr] = await next.finished();
  expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect(await exists(lockPath)).toBe(false);
}, 30_000);

test("many processes reclaiming eagerly from an aged empty lock never overlap or leave staging files", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  await ageLock(profile);
  // A 0 ms stale threshold reclaims every ownerless `.lock` at once, including
  // a contender's not-yet-linked one and a holder's mid-release one.
  const workers = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, cycleFixture, profile, holders, "25", "0"], {
    env: lockChildEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  }));
  const results = await Promise.all(workers.map(async (worker) => [await worker.exited, await new Response(worker.stderr).text()] as const));
  for (const [exit, stderr] of results) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect((await readdir(profilePath(profile))).filter((name) => name.startsWith(".lock"))).toEqual([]);
}, 60_000);

test("writers of this release and of the 842377d4 lock protocol never hold the lock together", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const olderFixture = new URL("../test-support/older-release-lock-cycle.ts", import.meta.url).pathname;
  // Realistic stale threshold: exclusion between versions rests on mkdir alone.
  const workers = [
    ...Array.from({ length: 4 }, () => Bun.spawn([process.execPath, cycleFixture, profile, holders, "25", "30000"], { env: lockChildEnv(home), stdout: "pipe", stderr: "pipe" })),
    ...Array.from({ length: 4 }, () => Bun.spawn([process.execPath, olderFixture, profile, holders, "25"], { env: lockChildEnv(home), stdout: "pipe", stderr: "pipe" })),
  ];
  const results = await Promise.all(workers.map(async (worker) => [await worker.exited, await new Response(worker.stderr).text()] as const));
  for (const [exit, stderr] of results) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect((await readdir(profilePath(profile))).filter((name) => name.startsWith(".lock"))).toEqual([]);
}, 60_000);

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
