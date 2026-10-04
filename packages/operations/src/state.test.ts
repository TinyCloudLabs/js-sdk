import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProfileDeletedError,
  ProfileLockTimeoutError,
  additionalDelegationsPath,
  authRequestsPath,
  profileConfigPath,
  profileLockMetadataPath,
  profileLockPath,
  profilePath,
  profileTurnLockPath,
  profileStoreMetadataPath,
  readAdditionalDelegations,
  recordProfileDeletion,
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
import { ageLock, appendFixture, exists, finishedChildren, lockChildEnv, spawnLockCycler, spawnLockHolder, violations } from "./test-support/lock-children.js";
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
    { staleAfterMs: 10_000, retryMs: 1 },
  );

  expect((await readProfileStore<{ requestId: string; revision: number }>(profile, "auth-requests")).records)
    .toEqual([request("req-stale")]);
  await expect(readFile(profileLockMetadataPath(profile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

// A contender's lock wait starts before it parks at the recovery barrier, so
// the time the parent waits for the other contender to boot counts against
// it. Correctness, not the 2 s default, is under test here.
const CONTENDER_LOCK_TIMEOUT_MS = "15000";

test("a TC-540 writer and a writer of this release recover one crashed stale lock without deleting the live replacement", async () => {
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

  // Two writers of this release recover one after the other (the turn lock
  // orders them); a TC-540 release recovers alongside, with its own claim.
  const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  const first = Bun.spawn([
    process.execPath,
    appendFixture,
    profile,
    "req-first-recovery",
    JSON.stringify(request("req-first-recovery")),
    CONTENDER_LOCK_TIMEOUT_MS,
  ], { env: { ...env, TC_TEST_LOCK_PROTOCOL: "tc540" }, stdout: "pipe", stderr: "pipe" });
  const second = Bun.spawn([
    process.execPath,
    appendFixture,
    profile,
    "req-second-recovery",
    JSON.stringify(request("req-second-recovery")),
    CONTENDER_LOCK_TIMEOUT_MS,
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
  expect((await readdir(profileLockPath(profile)).catch(() => [])).filter((name) => /^\.(?:stale|recover)-/.test(name))).toEqual([]);
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

// The tests below pause a process at a step of `.lock` acquisition, release
// or recovery and let others act meanwhile. Processes of this release take
// those steps only while holding a turn, so two of them can never interleave
// there; the paused (or racing) role is a TC-540 release's (its frozen lock
// code), which still shares `.lock` with this release.
const TC540 = { TC_TEST_LOCK_PROTOCOL: "tc540" } as const;

async function lockTestHome(): Promise<{ home: string; holders: string }> {
  const home = await isolatedHome();
  const holders = join(home, "holders");
  await mkdir(holders, { recursive: true });
  return { home, holders };
}

test("a TC-540 writer's delayed ownerless reclaim cannot remove the lock this release reclaimed and now holds", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const barrier = join(home, "ownerless-barrier");
  await mkdir(barrier, { recursive: true });
  // An ownerless lock left by an older release or a crash, a minute old.
  await mkdir(profileLockPath(profile), { recursive: true });
  await ageLock(profile);

  // C (TC-540) sees the aged empty lock and stops just before its rmdir.
  const late = spawnLockHolder(home, holders, profile, "late", { timeoutMs: 2000, staleAfterMs: 30_000, holdUntilReleased: false, env: { ...TC540, TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR: barrier } });
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

  // A pre-TC-540 writer: mkdir(.lock), paused before writing owner.json.
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

test("a TC-540 writer whose unpublished lock this release reclaimed and took over does not enter", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const barrier = join(home, "publish-barrier");
  await mkdir(barrier, { recursive: true });

  // B (TC-540) creates `.lock` and stops before linking its owner record.
  const contended = join(home, "b-contended");
  const slow = spawnLockHolder(home, holders, profile, "slow", { timeoutMs: 10_000, staleAfterMs: 30_000, env: { ...TC540, TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR: barrier, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended } });
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

test("a TC-540 holder's delayed rmdir in its release cannot hand the lock to two writers", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const releaseBarrier = join(home, "release-barrier");
  const publishBarrier = join(home, "publish-barrier");
  await mkdir(releaseBarrier, { recursive: true });
  await mkdir(publishBarrier, { recursive: true });

  // H (TC-540) takes the lock and stops mid-release, with `.lock` empty.
  const releasing = spawnLockHolder(home, holders, profile, "releasing", { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { ...TC540, TC_TEST_PROFILE_LOCK_RELEASE_BARRIER_DIR: releaseBarrier } });
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

async function crashedHolderLock(profile: string): Promise<void> {
  await mkdir(profileLockPath(profile), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(profile), {
    pid: 999_999_999,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    token: "crashed-holder",
  });
}

test("a TC-540 recoverer killed holding only its claim leaves a lock the next writer reclaims once aged", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const lockPath = profileLockPath(profile);
  const barrier = join(home, "claimed-barrier");
  await mkdir(barrier, { recursive: true });
  await crashedHolderLock(profile);

  // K (TC-540) recovers the dead holder's lock: links its `.stale-*` claim,
  // unlinks owner.json, and is killed before removing the claim.
  const killed = spawnLockHolder(home, holders, profile, "killed", { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { ...TC540, TC_TEST_PROFILE_LOCK_CLAIMED_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${killed.pid}-${profile}`), "K holding only its claim");
  killed.kill();
  await killed.finished();
  const left = await readdir(lockPath);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatch(/^\.stale-[0-9a-f-]+\.json$/);
  // A crashed acquirer's staged owner file, long abandoned.
  const staged = join(profilePath(profile), `.lock-owner-${randomUUID()}.tmp`);
  await writeFile(staged, "{}\n", "utf8");
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(staged, aMinuteAgo, aMinuteAgo);

  // While the claim is fresh (it may be a live TC-540 recoverer's) the lock is not reclaimed...
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

test("a recoverer of this release killed mid-recovery leaves a claim only this release can clear", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const lockPath = profileLockPath(profile);
  const barrier = join(home, "claimed-barrier");
  await mkdir(barrier, { recursive: true });
  await crashedHolderLock(profile);

  // K unlinks the dead owner while its .recover-* claim keeps .lock in
  // place, then dies. Older releases deliberately never remove this claim.
  const killed = spawnLockHolder(home, holders, profile, "killed", { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_CLAIMED_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${killed.pid}-${profile}`), "K holding only its claim");
  killed.kill();
  await killed.finished();
  const left = await readdir(lockPath);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatch(/^\.recover-[0-9a-f-]+\.json$/);

  await ageLock(profile);
  const older = spawnLockHolder(home, holders, profile, "older", { timeoutMs: 300, staleAfterMs: 30_000, env: TC540 });
  const [olderExit, olderError] = await older.finished();
  expect(olderExit, olderError).toBe(3);
  // The turn lock excludes another current-release writer until K exits;
  // afterward, an orphaned recovery claim can be cleared immediately.
  const next = spawnLockHolder(home, holders, profile, "next", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(next.readyPath, "the current writer reclaiming");
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: next.pid });
  await next.release();
  const [exit, stderr] = await next.finished();
  expect(exit, stderr).toBe(0);
  expect(await exists(lockPath)).toBe(false);
  expect(await violations(holders)).toEqual([]);
}, 30_000);

test("a TC-540 recoverer acting on an outdated observation never strands the live holder's lock", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const recoveryBarrier = join(home, "recovery-barrier");
  const claimBarrier = join(home, "claim-barrier");
  await mkdir(recoveryBarrier, { recursive: true });
  await mkdir(claimBarrier, { recursive: true });
  await crashedHolderLock(profile);

  // L (TC-540) observes the dead holder's record and stops before claiming it.
  const late = spawnLockHolder(home, holders, profile, "late", { timeoutMs: 10_000, staleAfterMs: 30_000, env: { ...TC540, TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR: recoveryBarrier, TC_TEST_PROFILE_LOCK_CLAIM_BARRIER_DIR: claimBarrier } });
  await waitForProfileLockProtocol(join(recoveryBarrier, `ready-${late.pid}-${profile}`), "L at its stale claim");
  // H recovers that lock first and holds a fresh one.
  const holder = spawnLockHolder(home, holders, profile, "holder", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(holder.readyPath, "H holding the recovered lock");

  // L's outdated claim lands on H's owner record, which stays in place.
  await writeFile(join(recoveryBarrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(join(claimBarrier, `ready-${late.pid}-${profile}`), "L holding its claim");
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: holder.pid });
  // H releases while L's claim is still inside `.lock`.
  await holder.release();
  const [holderExit, holderError] = await holder.finished();
  expect(holderExit, holderError).toBe(0);

  // L drops its claim, removes the lock H gave up, and acquires: the dead
  // record H released is never restored to block everyone until it ages.
  await writeFile(join(claimBarrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(late.readyPath, "L acquiring after H");
  await late.release();
  const [lateExit, lateError] = await late.finished();
  expect(lateExit, lateError).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect(await exists(profileLockPath(profile))).toBe(false);
}, 30_000);

test("a TC-540 recoverer paused past its fence drops its claim and never removes a newer holder's record", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const verifiedBarrier = join(home, "verified-barrier");
  const fencedBarrier = join(home, "fenced-barrier");
  await mkdir(verifiedBarrier, { recursive: true });
  await mkdir(fencedBarrier, { recursive: true });
  await crashedHolderLock(profile);

  // R1 (TC-540) links its claim, confirms it is the dead holder's record, and
  // is paused before unlinking owner.json. Its 4 ms stale threshold puts its
  // fence 2 ms after the claim, well inside the time the steps below take.
  const paused = spawnLockHolder(home, holders, profile, "paused", { timeoutMs: 10_000, staleAfterMs: 4, env: { ...TC540, TC_TEST_PROFILE_LOCK_VERIFIED_BARRIER_DIR: verifiedBarrier, TC_TEST_PROFILE_LOCK_FENCED_BARRIER_DIR: fencedBarrier } });
  await waitForProfileLockProtocol(join(verifiedBarrier, `ready-${paused.pid}-${profile}`), "R1 holding its confirmed claim");
  // R2 finishes the same recovery (unlinks the dead record); R1's claim keeps
  // `.lock` until a later cleanup finds it unchanged long enough and removes
  // the claim and the directory, after which H takes the lock.
  await rm(profileLockMetadataPath(profile));
  await ageLock(profile);
  const holder = spawnLockHolder(home, holders, profile, "holder", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(holder.readyPath, "H holding the lock after the cleanup");

  // R1 resumes long past its fence: it drops only its claim.
  await writeFile(join(verifiedBarrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(join(fencedBarrier, `ready-${paused.pid}-${profile}`), "R1 stopping at its fence");
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: holder.pid });
  await writeFile(join(fencedBarrier, "release"), "release\n", "utf8");

  await holder.release();
  const [holderExit, holderError] = await holder.finished();
  expect(holderExit, holderError).toBe(0);
  await waitForProfileLockProtocol(paused.readyPath, "R1 acquiring after H");
  await paused.release();
  const [pausedExit, pausedError] = await paused.finished();
  expect(pausedExit, pausedError).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 30_000);

test("many processes reclaiming eagerly from an aged empty lock never overlap or leave staging files", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  await ageLock(profile);
  // A 20 ms stale threshold reclaims an ownerless `.lock` almost at once.
  const workers = Array.from({ length: 8 }, () => spawnLockCycler(home, holders, profile, { iterations: 25, staleAfterMs: 20 }));
  for (const [exit, stderr] of await finishedChildren(workers)) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect((await readdir(profilePath(profile))).filter((name) => name.startsWith(".lock"))).toEqual([]);
  // Only the latest turn is left, and no staging or trash entries.
  expect(await readdir(profileTurnLockPath(profile))).toEqual(["200"]);
}, 60_000);

test("writers of this release, of TC-540 releases and of pre-TC-540 releases never hold the lock together", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  // Realistic stale threshold: exclusion between releases rests on mkdir alone.
  const workers = (["current", "tc540", "pre-tc540"] as const).flatMap((protocol) =>
    Array.from({ length: 3 }, () => spawnLockCycler(home, holders, profile, { iterations: 25, staleAfterMs: 30_000, protocol })));
  for (const [exit, stderr] of await finishedChildren(workers)) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
  expect((await readdir(profilePath(profile))).filter((name) => name.startsWith(".lock"))).toEqual([]);
}, 120_000);

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

test("a store write that waited out a profile deletion refuses it and leaves no profile behind", async () => {
  const home = await isolatedHome();
  const profile = "delegate";
  await writeJsonAtomic(profileConfigPath(profile), legacyProfile);
  const contended = join(home, "contended");
  process.env.NODE_ENV = "test";
  process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = contended;
  try {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    // A deletion's critical section, as `tc profile delete` runs it.
    const deleting = withProfileLock(profile, async () => {
      entered.resolve();
      await finish.promise;
      await rm(profileConfigPath(profile));
      await recordProfileDeletion(profile);
    });
    await entered.promise;
    const writing = writeSession(profile, { value: "after-delete" }, { timeoutMs: 5_000, retryMs: 5 });
    while (!await exists(contended)) { /* each stat yields to the writer */ }
    finish.resolve();
    await deleting;
    // The deletion removes the empty directory once it has released the lock.
    await rmdir(profilePath(profile)).catch(() => undefined);

    await expect(writing).rejects.toBeInstanceOf(ProfileDeletedError);
    expect(await exists(profilePath(profile))).toBe(false);
    // A write that starts after the deletion is a new write, as before.
    await writeSession(profile, { value: "new" });
    expect(await readSession(profile)).toEqual({ value: "new" });
  } finally {
    delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  }
});

test("a process paused after finding a turn's holder gone changes nothing once others have moved on", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const settleBarrier = join(home, "settle-barrier");
  await mkdir(settleBarrier);
  // A holder killed while holding its turn and `.lock`. A 20 ms stale
  // threshold lets the others recover its `.lock` at once; the turn lock
  // itself uses no threshold.
  const crashed = spawnLockHolder(home, holders, profile, "crashed", { timeoutMs: 10_000, staleAfterMs: 20 });
  await waitForProfileLockProtocol(crashed.readyPath, "the holder taking the lock");
  crashed.kill();
  await crashed.finished();
  await rm(join(holders, "active"));

  // S finds the crashed holder gone and stops before finishing its turn.
  const contended = join(home, "settler-contended");
  const settler = spawnLockHolder(home, holders, profile, "settler", { timeoutMs: 20_000, staleAfterMs: 20, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_TURN_SETTLE_BARRIER_DIR: settleBarrier, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended } });
  await waitForProfileLockProtocol(join(settleBarrier, `ready-${settler.pid}-${profile}`), "S about to finish the crashed turn");
  // Another process finishes that turn, takes the lock and gives it up; H
  // then takes the lock and holds it.
  const [otherExit, otherError] = await spawnLockHolder(home, holders, profile, "other", { timeoutMs: 10_000, staleAfterMs: 20, holdUntilReleased: false }).finished();
  expect(otherExit, otherError).toBe(0);
  const holder = spawnLockHolder(home, holders, profile, "holder", { timeoutMs: 10_000, staleAfterMs: 20 });
  await waitForProfileLockProtocol(holder.readyPath, "H holding the lock");

  // S resumes: its late markers name the crashed turn's token, so they change
  // nothing, and it waits for H.
  await writeFile(join(settleBarrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(contended, "S waiting for H");
  expect(await exists(settler.readyPath)).toBe(false);
  expect(JSON.parse(await readFile(profileLockMetadataPath(profile), "utf8"))).toMatchObject({ pid: holder.pid });

  await holder.release();
  for (const [exit, stderr] of await Promise.all([holder.finished(), settler.finished()])) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 60_000);

test("a turn republished by a paused process after its removal is void, and a paused collector removes only that", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const turns = profileTurnLockPath(profile);
  const publishBarrier = join(home, "turn-publish-barrier");
  const collectBarrier = join(home, "turn-collect-barrier");
  await mkdir(publishBarrier);
  await mkdir(collectBarrier);
  const turnNumbers = async () => (await readdir(turns)).filter((name) => /^\d+$/.test(name)).sort();

  // P creates the turn lock, reads turn 0 and stops before publishing turn 1.
  const contended = join(home, "paused-contended");
  const paused = spawnLockHolder(home, holders, profile, "paused", { timeoutMs: 20_000, staleAfterMs: 30_000, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR: publishBarrier, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contended } });
  await waitForProfileLockProtocol(join(publishBarrier, `ready-${paused.pid}-${profile}`), "P about to publish turn 1");
  // W takes turn 1. G takes turn 2 and stops while collecting, about to remove turn 1.
  const once = (name: string, env: Record<string, string> = {}) =>
    spawnLockHolder(home, holders, profile, name, { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false, env });
  const [firstExit, firstError] = await once("first").finished();
  expect(firstExit, firstError).toBe(0);
  const collector = once("collector", { TC_TEST_PROFILE_LOCK_TURN_COLLECT_BARRIER_DIR: collectBarrier });
  await waitForProfileLockProtocol(join(collectBarrier, `ready-${collector.pid}-${profile}`), "G about to remove turn 1");
  // A takes turn 3 and removes turns 1 and 2; H takes turn 4 and holds.
  const [advancingExit, advancingError] = await once("advancing").finished();
  expect(advancingExit, advancingError).toBe(0);
  expect(await turnNumbers()).toEqual(["3"]);
  const holder = spawnLockHolder(home, holders, profile, "holder", { timeoutMs: 10_000, staleAfterMs: 30_000 });
  await waitForProfileLockProtocol(holder.readyPath, "H holding turn 4");

  // P resumes: it publishes turn 1 again, finds turn 0 gone, leaves turn 1
  // void (done, never granted), and waits for H.
  await writeFile(join(publishBarrier, "release"), "release\n", "utf8");
  await waitForProfileLockProtocol(contended, "P waiting for H");
  const republished = await readdir(join(turns, "1"));
  expect(republished.filter((name) => name.endsWith(".done"))).toHaveLength(1);
  expect(republished.filter((name) => name.endsWith(".held"))).toEqual([]);
  expect(await exists(paused.readyPath)).toBe(false);

  // G resumes and removes what is at turn 1 now: P's void turn.
  await writeFile(join(collectBarrier, "release"), "release\n", "utf8");
  const [collectorExit, collectorError] = await collector.finished();
  expect(collectorExit, collectorError).toBe(0);
  // Turn 3 goes once H's turn 4 is over.
  expect(await turnNumbers()).toEqual(["3", "4"]);

  await holder.release();
  for (const [exit, stderr] of await Promise.all([holder.finished(), paused.finished()])) expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 60_000);

test("collectors remove a crashed process's staged turn but never a paused one's", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const turns = profileTurnLockPath(profile);
  const barrier = join(home, "turn-publish-barrier");
  await mkdir(barrier);
  const stages = async () => (await readdir(turns)).filter((name) => name.startsWith(".stage-"));

  // K and P each stage turn 1 and stop before publishing it; K is killed.
  const staging = (name: string) =>
    spawnLockHolder(home, holders, profile, name, { timeoutMs: 20_000, staleAfterMs: 1, holdUntilReleased: false, env: { TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR: barrier } });
  const crashed = staging("crashed");
  await waitForProfileLockProtocol(join(barrier, `ready-${crashed.pid}-${profile}`), "K about to publish");
  const paused = staging("paused");
  await waitForProfileLockProtocol(join(barrier, `ready-${paused.pid}-${profile}`), "P about to publish");
  crashed.kill();
  await crashed.finished();
  expect(await stages()).toHaveLength(2);

  // Another writer takes two turns and collects after each. A 1 ms stale
  // threshold has long aged both staging directories: only K's goes.
  for (const [exit, stderr] of await finishedChildren([spawnLockCycler(home, holders, profile, { iterations: 2, staleAfterMs: 1 })])) {
    expect(exit, stderr).toBe(0);
  }
  const left = await stages();
  expect(left).toHaveLength(1);
  expect(left[0]!.startsWith(`.stage-${paused.pid}-`)).toBe(true);

  // P publishes turn 1 again, finds it void, and takes the next turn.
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  const [pausedExit, pausedError] = await paused.finished();
  expect(pausedExit, pausedError).toBe(0);
  expect(await violations(holders)).toEqual([]);
}, 60_000);

// Faults are injected with permissions, which do not bind root.
const runsAsRoot = process.getuid?.() === 0;
const turnFaultFixture = new URL("../test-support/turn-fault.ts", import.meta.url).pathname;

/** A long-lived writer (test-support/turn-fault.ts) that reports its first and second acquisitions. */
interface TurnFaultWriter {
  readonly pid: number;
  readonly signals: string;
  outcome(name: "first" | "second"): Promise<string>;
  retry(): Promise<void>;
  finished(): Promise<readonly [number, string]>;
}

async function spawnTurnFault(home: string, holders: string, profile: string, options: { hold?: boolean; env?: Record<string, string> } = {}): Promise<TurnFaultWriter> {
  const signals = join(home, "signals");
  await mkdir(signals, { recursive: true });
  const child = Bun.spawn([process.execPath, turnFaultFixture, profile, holders, signals, options.hold ? "hold" : "-"], {
    env: lockChildEnv(home, options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const outcome = async (name: "first" | "second") => {
    await waitForProfileLockProtocol(join(signals, name), `the writer's ${name} acquisition`);
    return readFile(join(signals, name), "utf8");
  };
  return {
    pid: child.pid,
    signals,
    outcome,
    retry: () => writeFile(join(signals, "retry"), "retry\n", "utf8"),
    finished: async () => [await child.exited, await new Response(child.stderr).text()] as const,
  };
}

/** Another process and then the writer's own process each take the lock. */
async function expectLockTakenAgain(home: string, holders: string, profile: string, writer: TurnFaultWriter, others = 1): Promise<void> {
  for (let index = 0; index < others; index++) {
    const [exit, stderr] = await spawnLockHolder(home, holders, profile, `other-${index}`, { timeoutMs: 10_000, staleAfterMs: 30_000, holdUntilReleased: false }).finished();
    expect(exit, stderr).toBe(0);
  }
  await writer.retry();
  expect(await writer.outcome("second")).toBe("ok");
  const [exit, stderr] = await writer.finished();
  expect(exit, stderr).toBe(0);
  expect(await violations(holders)).toEqual([]);
}

test.skipIf(runsAsRoot)("a held marker that cannot be written strands no turn once writes work again", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const turns = profileTurnLockPath(profile);
  const barrier = join(home, "turn-publish-barrier");
  await mkdir(barrier);
  const writer = await spawnTurnFault(home, holders, profile, { env: { TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${writer.pid}-${profile}`), "the writer about to publish turn 1");
  // Its staged turn becomes read-only: once published, `held` cannot be written in it.
  const [stage] = (await readdir(turns)).filter((name) => name.startsWith(".stage-"));
  await chmod(join(turns, stage!), 0o500);
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  expect(await writer.outcome("first")).toBe("EACCES");

  // The disk works again; the writer's process is still alive.
  await chmod(join(turns, "1"), 0o700);
  await expectLockTakenAgain(home, holders, profile, writer);
}, 60_000);

test.skipIf(runsAsRoot)("a done marker that cannot be written keeps the critical section's result and strands no turn", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const turns = profileTurnLockPath(profile);
  const writer = await spawnTurnFault(home, holders, profile, { hold: true });
  await waitForProfileLockProtocol(join(writer.signals, "holding"), "the writer holding the lock");
  // Its turn becomes read-only: `done` cannot be written when it releases.
  const turn = String(Math.max(...(await readdir(turns)).filter((name) => /^\d+$/.test(name)).map(Number)));
  await chmod(join(turns, turn), 0o500);
  await writeFile(join(writer.signals, "release"), "release\n", "utf8");
  expect(await writer.outcome("first")).toBe("ok");

  await chmod(join(turns, turn), 0o700);
  await expectLockTakenAgain(home, holders, profile, writer);
}, 60_000);

test.skipIf(runsAsRoot)("a turn whose predecessor cannot be read is left undecided, not void, and settled once it can", async () => {
  const { home, holders } = await lockTestHome();
  const profile = "delegate";
  const turns = profileTurnLockPath(profile);
  const barrier = join(home, "turn-publish-barrier");
  await mkdir(barrier);
  const writer = await spawnTurnFault(home, holders, profile, { env: { TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR: barrier } });
  await waitForProfileLockProtocol(join(barrier, `ready-${writer.pid}-${profile}`), "the writer about to publish turn 1");
  // Turn 0, which the writer read and will check again, becomes unreadable.
  await chmod(join(turns, "0"), 0o000);
  await writeFile(join(barrier, "release"), "release\n", "utf8");
  expect(await writer.outcome("first")).toBe("EACCES");

  await chmod(join(turns, "0"), 0o700);
  await expectLockTakenAgain(home, holders, profile, writer, 3);
}, 60_000);

test("a store write that arrives after the deletion was recorded, but before it released the lock, is refused", async () => {
  const home = await isolatedHome();
  const profile = "delegate";
  await writeJsonAtomic(profileConfigPath(profile), legacyProfile);
  const contended = join(home, "contended");
  process.env.NODE_ENV = "test";
  process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = contended;
  try {
    const recorded = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const deleting = withProfileLock(profile, async () => {
      await rm(profileConfigPath(profile));
      await recordProfileDeletion(profile);
      recorded.resolve();
      await finish.promise;
    });
    await recorded.promise;
    const writing = writeSession(profile, { value: "after-record" }, { timeoutMs: 5_000, retryMs: 5 });
    while (!await exists(contended)) { /* each stat yields to the writer */ }
    finish.resolve();
    await deleting;
    await rmdir(profilePath(profile)).catch(() => undefined);

    await expect(writing).rejects.toBeInstanceOf(ProfileDeletedError);
    expect(await exists(profilePath(profile))).toBe(false);
  } finally {
    delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  }
});

test("a store write that waited after a deletion and a re-creation of the profile is written", async () => {
  const home = await isolatedHome();
  const profile = "delegate";
  await writeJsonAtomic(profileConfigPath(profile), legacyProfile);
  await withProfileLock(profile, async () => {
    await rm(profileConfigPath(profile));
    await recordProfileDeletion(profile);
  });
  await withProfileLock(profile, () => writeJsonAtomic(profileConfigPath(profile), legacyProfile));
  const contended = join(home, "contended");
  process.env.NODE_ENV = "test";
  process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = contended;
  try {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const holding = withProfileLock(profile, async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const writing = writeSession(profile, { value: "recreated" }, { timeoutMs: 5_000, retryMs: 5 });
    while (!await exists(contended)) { /* each stat yields to the writer */ }
    finish.resolve();
    await holding;
    await writing;
    expect(await readSession(profile)).toEqual({ value: "recreated" });
  } finally {
    delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  }
});

test("a crashed process's staging directory beside the turn lock is collected; a live one is kept", async () => {
  await isolatedHome();
  const profile = "delegate";
  await withProfileLock(profile, async () => undefined);
  const parent = dirname(profileTurnLockPath(profile));
  const crashed = join(parent, `.stage-${profile}-999999999-${randomUUID()}`);
  const live = join(parent, `.stage-other-${process.pid}-${randomUUID()}`);
  await mkdir(join(crashed, "0"), { recursive: true });
  await mkdir(live);
  await withProfileLock(profile, async () => undefined);
  expect(await exists(crashed)).toBe(false);
  expect(await exists(live)).toBe(true);
});

test("a damaged or never-granted top turn times out naming the turn lock and how to recover", async () => {
  await isolatedHome();
  const profile = "delegate";
  await withProfileLock(profile, async () => undefined);
  const turns = profileTurnLockPath(profile);
  const top = Math.max(...(await readdir(turns)).filter((name) => /^\d+$/.test(name)).map(Number));
  const attempt = () => withProfileLock(profile, async () => undefined, { timeoutMs: 100, retryMs: 5 });

  // A never-granted turn on top (done without held).
  const token = randomUUID();
  await mkdir(join(turns, String(top + 1)));
  await writeFile(join(turns, String(top + 1), "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token, after: "another" }));
  await writeFile(join(turns, String(top + 1), `${token}.done`), "");
  const neverGranted = await attempt().catch((error: unknown) => error);
  expect(neverGranted).toBeInstanceOf(ProfileLockTimeoutError);
  expect((neverGranted as Error).message).toContain(`${turns} ends with turn ${top + 1}, which was never granted`);
  expect((neverGranted as Error).message).toContain("remove that directory");

  // A truncated owner record on top.
  await writeFile(join(turns, String(top + 1), "owner.json"), "{\"pid\": 1");
  const unreadable = await attempt().catch((error: unknown) => error);
  expect(unreadable).toBeInstanceOf(ProfileLockTimeoutError);
  expect((unreadable as Error).message).toContain(`${turns} has an unreadable turn ${top + 1}`);

  // The documented recovery: remove the directory while nothing uses the profile.
  await rm(turns, { recursive: true });
  await withProfileLock(profile, async () => undefined, { timeoutMs: 1_000 });
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
