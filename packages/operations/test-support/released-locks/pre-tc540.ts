// The profile lock of the releases before TC-540 (js-sdk 48eca361^, CLI up
// to 1.0.0-beta.16), copied verbatim so tests can run a realistic older
// writer against this release. It holds the lock from the moment
// `mkdir(.lock)` succeeds, before `owner.json` exists, and writes owner.json
// with a replacing rename. Do not change the lock code below; it stands for
// released binaries. The one addition is a test-only pause where it holds
// the lock without an owner record (TC_TEST_PROFILE_LOCK_PRE_TC540_OWNER_
// BARRIER_DIR); it does not change what the writer does.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  ProfileLockTimeoutError,
  profileLockMetadataPath,
  profileLockPath,
  profilePath,
  readJson,
  type ProfileLockOptions,
} from "../../src/state.js";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;
const TEST_LOCK_CONTENTION_SIGNAL_PATH = "TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH";
const TEST_LOCK_RECOVERY_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR";
const TEST_LOCK_OWNER_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_PRE_TC540_OWNER_BARRIER_DIR";

/** Runs `action` holding the profile lock the way pre-TC-540 releases do (not reentrant). */
export async function withPreTc540ProfileLock<T>(
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

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
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

  await mkdir(profilePath(profile), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await waitForTestBarrier(TEST_LOCK_OWNER_BARRIER_DIR, profile); // test-only addition
      const token = randomUUID();
      try {
        await writeJsonAtomic(profileLockMetadataPath(profile), {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token,
        });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }

      return async () => {
        await releaseProfileLock(lockPath, token);
      };
    } catch (error) {
      if (!isLockAlreadyHeld(error)) throw error;
      await signalTestLockContention(profile);
    }

    if (await recoverStaleLock(profile, lockPath, staleAfterMs)) continue;

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new ProfileLockTimeoutError(profile, timeoutMs);
    }
    await sleep(Math.min(retryMs, timeoutMs - elapsedMs));
  }
}

async function releaseProfileLock(lockPath: string, token: string): Promise<void> {
  const ownerPath = join(lockPath, "owner.json");
  const claimPath = join(lockPath, `.release-${token}.json`);
  try {
    await rename(ownerPath, claimPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }

  const claimed = await readJson<{ token?: unknown }>(claimPath).catch(() => null);
  if (claimed?.token !== token) {
    await rename(claimPath, ownerPath).catch(() => undefined);
    return;
  }

  await rm(claimPath, { force: true });
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

async function recoverStaleLock(profile: string, lockPath: string, staleAfterMs: number): Promise<boolean> {
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readJson<{ pid?: unknown; createdAt?: unknown; token?: unknown }>(ownerPath)
    .catch(() => null);
  if (!isStaleOwner(owner, staleAfterMs)) return false;

  // Claim the observed metadata file, rather than renaming/removing the lock
  // directory. A contender can only acquire the directory after it is empty;
  // rmdir below therefore cannot remove a replacement lock instance.
  const observedToken = typeof owner?.token === "string" && owner.token.length > 0
    ? owner.token
    : "legacy";
  await waitForTestStaleRecoveryBarrier(profile);
  const claimPath = join(lockPath, `.stale-${randomUUID()}.json`);
  try {
    await rename(ownerPath, claimPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    return false;
  }

  const claimed = await readJson<{ pid?: unknown; createdAt?: unknown; token?: unknown }>(claimPath)
    .catch(() => null);
  const sameInstance = claimed !== null && (
    observedToken === "legacy"
      ? claimed.token === undefined
      : claimed.token === observedToken
  );
  if (!sameInstance) {
    await rename(claimPath, ownerPath).catch(() => undefined);
    return false;
  }

  await rm(claimPath, { force: true });
  await rmdir(lockPath).catch(() => undefined);
  return true;
}

async function waitForTestStaleRecoveryBarrier(profile: string): Promise<void> {
  await waitForTestBarrier(TEST_LOCK_RECOVERY_BARRIER_DIR, profile);
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
  // An ownerless or malformed directory may still be between mkdir and
  // metadata publication, so reclaiming it could let two writers enter the
  // critical section. Current writers claim .lock with exclusive mkdir before
  // publishing owner metadata and therefore take the same conservative path.
  if (!Number.isFinite(createdAt) || now - createdAt < staleAfterMs) return false;
  if (typeof owner?.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  return !isProcessAlive(owner.pid);
}

function isLockAlreadyHeld(error: unknown): boolean {
  return isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY");
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
