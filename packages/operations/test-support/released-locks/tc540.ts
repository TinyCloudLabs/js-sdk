// The profile lock of the TC-540 and TC-548 releases (js-sdk 9b62dae7,
// @tinycloud/cli 1.0.0 to 1.0.1-beta.2), copied verbatim so tests can run a
// realistic older writer against this release: `mkdir(.lock)`, then `link` a
// staged owner record to `.lock/owner.json`; it holds the lock only once the
// link succeeds. Do not change the lock code below; it stands for released
// binaries.
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  ProfileLockTimeoutError,
  profileLockPath,
  profilePath,
  profilesPath,
  readJson,
  tinycloudHomePath,
  type ProfileLockOptions,
} from "../../src/state.js";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;
const TEST_LOCK_CONTENTION_SIGNAL_PATH = "TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const TEST_LOCK_RECOVERY_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR";
const TEST_LOCK_OWNERLESS_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR";
const TEST_LOCK_PUBLISH_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR";
const TEST_LOCK_RELEASE_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_RELEASE_BARRIER_DIR";
const TEST_LOCK_CLAIM_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_CLAIM_BARRIER_DIR";
const TEST_LOCK_CLAIMED_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_CLAIMED_BARRIER_DIR";
const TEST_LOCK_FENCED_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_FENCED_BARRIER_DIR";
const TEST_LOCK_VERIFIED_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_VERIFIED_BARRIER_DIR";

/** Runs `action` holding the profile lock the way the TC-540 release does (not reentrant). */
export async function withTc540ProfileLock<T>(
  profile: string,
  action: () => Promise<T>,
  options: ProfileLockOptions = {},
): Promise<T> {
  const release = await acquireProfileLock(profile, options);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function acquireProfileLock(
  profile: string,
  options: ProfileLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  const startedAt = Date.now();
  const lockPath = profileLockPath(profile);

  const directory = profilePath(profile);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Every store write takes this lock: tighten the tree older releases
  // created 0775 before writing sessions or delegations into it.
  for (const path of [tinycloudHomePath(), profilesPath(), directory]) {
    await chmod(path, PRIVATE_DIR_MODE).catch((error: unknown) => {
      // A profile deletion can remove the profile directory right after the
      // mkdir above; the lock attempt below recreates it 0700.
      if (path !== directory || !isErrno(error, "ENOENT")) throw error;
    });
  }

  while (true) {
    const token = randomUUID();
    if (await publishProfileLock(profile, lockPath, token)) {
      return async () => {
        await releaseProfileLock(profile, lockPath, token);
      };
    }
    await signalTestLockContention(profile);

    if (await recoverStaleLock(profile, lockPath, staleAfterMs)) continue;

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new ProfileLockTimeoutError(profile, timeoutMs);
    }
    await sleep(Math.min(retryMs, timeoutMs - elapsedMs));
  }
}

/**
 * One attempt to take the lock. Nothing here replaces an existing path:
 *
 * 1. `mkdir(.lock)` (never recursive) is exclusive, and is the primitive
 *    older releases use too, so they exclude each other.
 * 2. Ownership is published by `link`ing a fully written owner file (staged
 *    beside `.lock`, on the same filesystem) to `.lock/owner.json`. `link`
 *    fails with EEXIST if an owner exists, and with ENOENT if the directory
 *    was removed meanwhile (an aged ownerless-lock reclaim). Only a
 *    successful link holds the lock; on either failure nothing is released,
 *    since nothing was acquired, and the caller retries.
 *
 * A profile deletion removes the profile directory once it has released its
 * lock, so `mkdir(.lock)` can see ENOENT; the directory is recreated (0700)
 * and the caller retries within its deadline, as for a first write to a new
 * profile.
 *
 * Only one owner.json can exist at the lock path, and it is removed only by
 * its holder's release or by recovery of a dead holder, so at most one
 * process holds the lock. Returns false when the lock is not acquired.
 */
async function publishProfileLock(profile: string, lockPath: string, token: string): Promise<boolean> {
  try {
    await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(profilePath(profile), { recursive: true, mode: PRIVATE_DIR_MODE });
    return false;
  }
  await waitForTestBarrier(TEST_LOCK_PUBLISH_BARRIER_DIR, profile);
  const staged = join(dirname(lockPath), `.lock-owner-${token}.tmp`);
  const owner = { pid: process.pid, createdAt: new Date().toISOString(), token };
  try {
    await writeFile(staged, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    await link(staged, join(lockPath, "owner.json"));
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST") || isErrno(error, "ENOENT")) return false;
    // Do not leave an ownerless lock behind for others to wait out. rmdir
    // removes only an empty directory; anyone who created it after ours went
    // away sees ENOENT on link and retries.
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

/**
 * Releases the lock if `.lock/owner.json` is still this acquisition's. No
 * one else can put an owner record there while it exists (owners are only
 * linked into a directory their own `mkdir` created, and recovery removes
 * only a dead holder's record), so the record read is the one unlinked.
 */
async function releaseProfileLock(profile: string, lockPath: string, token: string): Promise<void> {
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readJson<{ token?: unknown }>(ownerPath).catch(() => null);
  if (owner?.token !== token) return;
  await rm(ownerPath, { force: true });
  // `.lock` is empty from here until the rmdir; a contender that removes it
  // and creates its own meanwhile is not harmed: rmdir fails on its owner
  // file, or the contender's link sees ENOENT and retries. If a recoverer's
  // claim file is still inside, rmdir fails and that recoverer removes the
  // directory when it drops its claim.
  await waitForTestBarrier(TEST_LOCK_RELEASE_BARRIER_DIR, profile);
  await rmdir(lockPath).catch(() => undefined);
}

/**
 * Gives process-level contention tests an event-driven witness that a second
 * writer has reached an already-held lock. This deliberately has no effect
 * outside an explicit test environment, and only creates a new signal file
 * beneath TC_HOME; it never changes lock acquisition or release semantics.
 */
async function signalTestLockContention(profile: string): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;

  const configuredPath = process.env[TEST_LOCK_CONTENTION_SIGNAL_PATH];
  const configuredHome = process.env.TC_HOME;
  if (!configuredPath || !configuredHome) return;

  const home = resolve(configuredHome);
  const signalPath = resolve(configuredPath);
  const pathFromHome = relative(home, signalPath);
  if (
    pathFromHome === "" ||
    pathFromHome === ".." ||
    pathFromHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    pathFromHome.startsWith("../") ||
    pathFromHome.startsWith("..\\")
  ) {
    return;
  }

  await writeFile(signalPath, `${profile}\n`, { encoding: "utf8", flag: "wx" })
    .catch(() => undefined);
}

/**
 * Reclaims a lock directory with no owner record that is older than the
 * stale threshold: one left by a crash, or by an older release. A process
 * killed while recovering (or releasing, in older releases) can leave its
 * `.stale-*` / `.release-*` claim file behind; such claim files are removed
 * first. owner.json is never touched, and the directory itself is only
 * `rmdir`ed, which succeeds only while it is empty, so a published lock is
 * never removed. If the directory was a contender's lock not yet published,
 * that contender's `link` fails with ENOENT and it retries without holding
 * anything.
 */
async function recoverOwnerlessLock(profile: string, lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs < staleAfterMs) return false;
  } catch {
    return false;
  }
  const checkedAt = performance.now();
  await waitForTestBarrier(TEST_LOCK_OWNERLESS_BARRIER_DIR, profile);
  try {
    const entries = await readdir(lockPath);
    if (entries.includes("owner.json")) return false;
    // The age check above is only good for a while; see recoveryFenced.
    if (recoveryFenced(checkedAt, staleAfterMs)) return false;
    for (const name of entries.filter((entry) => ABANDONED_CLAIM.test(entry))) {
      await rm(join(lockPath, name), { force: true });
    }
    await rmdir(lockPath);
  } catch {
    return false;
  }
  await removeAgedOwnerFiles(lockPath, staleAfterMs);
  return true;
}

/**
 * Whether a recovery step decided at `since` (a monotonic timestamp) is too
 * old to act on. Claim-only and ownerless cleanup act only on a `.lock`
 * unchanged for `staleAfterMs`, and a recoverer's claim (or the change that
 * made a directory look abandoned) dates the directory no earlier than
 * `since`. Acting within half that window means no such cleanup can have
 * removed the directory and let a new holder in meanwhile; past it, the
 * recoverer drops only its own claim and starts the acquisition over.
 */
function recoveryFenced(since: number, staleAfterMs: number): boolean {
  return performance.now() - since >= staleAfterMs / 2;
}

/** Claim files of stale recovery (and of release in older releases). */
const ABANDONED_CLAIM = /^\.(?:release|stale)-[0-9a-f-]+\.json$/;
/** Owner files staged by publishProfileLock beside `.lock`. */
const STAGED_OWNER = /^\.lock-owner-[0-9a-f-]+\.tmp$/;

/**
 * Removes owner files a crashed acquirer staged beside `.lock`. A live
 * acquirer's staged file exists only for its write and link, so only files
 * older than the stale threshold are removed. Runs after a recovery, never
 * on the uncontended path.
 */
async function removeAgedOwnerFiles(lockPath: string, staleAfterMs: number): Promise<void> {
  const directory = dirname(lockPath);
  const names = await readdir(directory).catch(() => []);
  for (const name of names.filter((entry) => STAGED_OWNER.test(entry))) {
    const path = join(directory, name);
    const aged = await stat(path).then(({ mtimeMs }) => Date.now() - mtimeMs >= staleAfterMs, () => false);
    if (aged) await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * Removes a dead holder's lock. The claim is a hard link to owner.json, so
 * the owner record is never moved away: a recoverer whose observation is
 * outdated (the dead holder's lock was already recovered and a live holder
 * now owns `.lock`) sees another token, drops its link and leaves the live
 * owner record in place. Only after the claimed record is confirmed to be
 * the observed dead holder's is owner.json unlinked. Nothing can link a new
 * owner.json meanwhile: the claim keeps `.lock` non-empty, so it cannot be
 * removed and recreated.
 */
async function recoverStaleLock(profile: string, lockPath: string, staleAfterMs: number): Promise<boolean> {
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readJson<{ pid?: unknown; createdAt?: unknown; token?: unknown }>(ownerPath)
    .catch(() => null);
  if (owner === null) return recoverOwnerlessLock(profile, lockPath, staleAfterMs);
  if (!isStaleOwner(owner, staleAfterMs)) return false;

  const observedToken = typeof owner?.token === "string" && owner.token.length > 0
    ? owner.token
    : "legacy";
  await waitForTestBarrier(TEST_LOCK_RECOVERY_BARRIER_DIR, profile);
  const claimPath = join(lockPath, `.stale-${randomUUID()}.json`);
  try {
    await link(ownerPath, claimPath);
  } catch {
    return false;
  }
  const claimedAt = performance.now();
  await waitForTestBarrier(TEST_LOCK_CLAIM_BARRIER_DIR, profile);

  const claimed = await readJson<{ pid?: unknown; createdAt?: unknown; token?: unknown }>(claimPath)
    .catch(() => null);
  const sameInstance = claimed !== null && (
    observedToken === "legacy"
      ? claimed.token === undefined
      : claimed.token === observedToken
  );
  await waitForTestBarrier(TEST_LOCK_VERIFIED_BARRIER_DIR, profile);
  if (sameInstance && recoveryFenced(claimedAt, staleAfterMs)) {
    // Paused too long: another recoverer may have finished this recovery and
    // a cleanup may have removed this claim, so owner.json may now be a live
    // holder's. Touch nothing but this claim.
    await rm(claimPath, { force: true });
    await waitForTestBarrier(TEST_LOCK_FENCED_BARRIER_DIR, profile);
    return false;
  }
  if (sameInstance) {
    await rm(ownerPath, { force: true });
    await waitForTestBarrier(TEST_LOCK_CLAIMED_BARRIER_DIR, profile);
  }
  await rm(claimPath, { force: true });
  // Empty now if the claimed holder is gone or a live holder released while
  // this claim kept `.lock` from being removed: remove it rather than leave
  // an ownerless lock to age out. rmdir fails while an owner record exists.
  await rmdir(lockPath).catch(() => undefined);
  if (!sameInstance) return false;
  await removeAgedOwnerFiles(lockPath, staleAfterMs);
  return true;
}

/** Test-only rendezvous (NODE_ENV=test and the named barrier directory set). */
async function waitForTestBarrier(environmentName: string, profile: string): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const barrierDirectory = process.env[environmentName];
  if (!barrierDirectory) return;
  await mkdir(barrierDirectory, { recursive: true });
  const readyPath = join(barrierDirectory, `ready-${process.pid}-${profile}`);
  await writeFile(readyPath, "ready\n", { encoding: "utf8", flag: "wx" }).catch(() => undefined);
  const releasePath = join(barrierDirectory, "release");
  while (true) {
    try {
      await readFile(releasePath, "utf8");
      return;
    } catch {
      await sleep(1);
    }
  }
}

function isStaleOwner(
  owner: { pid?: unknown; createdAt?: unknown } | null,
  staleAfterMs: number,
): boolean {
  const now = Date.now();
  const createdAt = typeof owner?.createdAt === "string"
    ? Date.parse(owner.createdAt)
    : Number.NaN;

  // Reclaim only a fully published lock whose owner PID is confirmed dead.
  // A lock without an owner record is handled by recoverOwnerlessLock: a
  // process holds the lock only once its owner.json is linked in.
  if (!Number.isFinite(createdAt) || now - createdAt < staleAfterMs) return false;
  if (typeof owner?.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  return !isProcessAlive(owner.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}


function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
