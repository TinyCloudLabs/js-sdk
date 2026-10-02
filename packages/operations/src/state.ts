import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_PROFILE = "default";
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;
const TEST_LOCK_CONTENTION_SIGNAL_PATH = "TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH";
// Profile state holds keys, sessions and delegations: owner-only access.
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const TEST_LOCK_RECOVERY_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_RECOVERY_BARRIER_DIR";
const invocationStateRoot = new AsyncLocalStorage<string>();
/** One acquisition of a profile lock; `active` is cleared before release. */
interface HeldProfileLock {
  readonly lockPath: string;
  active: boolean;
}
/** Profile lock acquisitions held by the current async call chain (see withProfileLock). */
const heldProfileLocks = new AsyncLocalStorage<readonly HeldProfileLock[]>();

export type ProfileStoreName =
  | "session"
  | "additional-delegations"
  | "auth-requests";

export interface StoreMetadata {
  formatVersion: number;
}

export interface ProfileStoreContents<T> {
  formatVersion: number;
  records: T[];
}

export interface ProfileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleAfterMs?: number;
}

export class ProfileLockTimeoutError extends Error {
  readonly code = "PROFILE_LOCK_TIMEOUT";

  constructor(profile: string, timeoutMs: number) {
    super(`Timed out waiting for the profile lock for "${profile}" after ${timeoutMs}ms.`);
    this.name = "ProfileLockTimeoutError";
  }
}

/**
 * The CLI's delegated-secret path treats TC_HOME as a home directory, rather
 * than a direct TinyCloud directory. Keep the shared store on that convention.
 */
export function tinycloudHomePath(): string {
  const home = invocationStateRoot.getStore() ??
    process.env.TC_HOME ??
    process.env.HOME ??
    process.env.USERPROFILE ??
    homedir();
  return join(home, ".tinycloud");
}

/** Run one operation against an isolated TinyCloud home directory. */
export function withTinyCloudStateRoot<T>(
  stateRoot: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  if (stateRoot === undefined) return action();
  if (!isAbsolute(stateRoot) || stateRoot.includes("\0")) {
    throw new TypeError("The TinyCloud state root must be an absolute path.");
  }
  return invocationStateRoot.run(resolve(stateRoot), action);
}

export function tinycloudConfigPath(): string {
  return join(tinycloudHomePath(), "config.json");
}

export function profilesPath(): string {
  return join(tinycloudHomePath(), "profiles");
}

export function profilePath(profile: string): string {
  return join(profilesPath(), validateProfileName(profile));
}

export function profileConfigPath(profile: string): string {
  return join(profilePath(profile), "profile.json");
}

export function sessionPath(profile: string): string {
  return profileStorePath(profile, "session");
}

export function additionalDelegationsPath(profile: string): string {
  return profileStorePath(profile, "additional-delegations");
}

export function authRequestsPath(profile: string): string {
  return profileStorePath(profile, "auth-requests");
}

export function profileStorePath(profile: string, store: ProfileStoreName): string {
  return join(profilePath(profile), `${store}.json`);
}

/** The format record is deliberately separate from each legacy JSON payload. */
export function profileStoreMetadataPath(profile: string, store: ProfileStoreName): string {
  return `${profileStorePath(profile, store)}.metadata.json`;
}

export function profileLockPath(profile: string): string {
  return join(profilePath(profile), ".lock");
}

export function profileLockMetadataPath(profile: string): string {
  return join(profileLockPath(profile), "owner.json");
}

/**
 * Reads JSON without hiding malformed or inaccessible files. A missing file is
 * the only condition represented as null.
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

/**
 * Writes the same pretty-printed, trailing-newline JSON shape used by the CLI,
 * but publishes it with an atomic rename from the same directory.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readProfile<T extends object = Record<string, unknown>>(
  profile: string,
): Promise<T | null> {
  return readJson<T>(profileConfigPath(profile));
}

export async function readSession<T extends object = Record<string, unknown>>(
  profile: string,
): Promise<T | null> {
  await readStoreMetadata(profile, "session");
  return readJson<T>(sessionPath(profile));
}

export async function readAdditionalDelegations<T = Record<string, unknown>>(
  profile: string,
): Promise<T[]> {
  return (await readProfileStore<T>(profile, "additional-delegations")).records;
}

export async function readAuthRequests<T = Record<string, unknown>>(
  profile: string,
): Promise<T[]> {
  return (await readProfileStore<T>(profile, "auth-requests")).records;
}

export async function readStoreMetadata(
  profile: string,
  store: ProfileStoreName,
): Promise<StoreMetadata> {
  const metadata = await readJson<StoreMetadata>(profileStoreMetadataPath(profile, store));
  if (metadata === null) return { formatVersion: 1 };
  if (
    typeof metadata !== "object" ||
    metadata.formatVersion !== 1
  ) {
    throw new TypeError(`Unsupported store format for "${store}".`);
  }
  return metadata;
}

export async function readProfileStore<T>(
  profile: string,
  store: Exclude<ProfileStoreName, "session">,
): Promise<ProfileStoreContents<T>> {
  const [metadata, raw] = await Promise.all([
    readStoreMetadata(profile, store),
    readJson<unknown>(profileStorePath(profile, store)),
  ]);
  return {
    formatVersion: metadata.formatVersion,
    records: Array.isArray(raw) ? raw as T[] : [],
  };
}

/**
 * Runs a small critical section under the one advisory lock shared by all
 * profile stores. Lock release verifies its ownership token before removing
 * the exact metadata instance it acquired.
 *
 * Reentrant within one async call chain: a critical section that already
 * holds a profile's lock (for example a login's compare-and-commit) can call
 * store writers that take the same lock without deadlocking. Ownership is
 * keyed by the resolved lock path (so switching state roots inside a lock
 * still takes the other root's lock) and lasts exactly as long as the
 * acquisition: it is revoked before release, so work deferred past the
 * critical section waits for the lock like any other caller.
 */
export async function withProfileLock<T>(
  profile: string,
  action: () => Promise<T>,
  options: ProfileLockOptions = {},
): Promise<T> {
  const normalizedProfile = validateProfileName(profile);
  const lockPath = profileLockPath(normalizedProfile);
  const held = (heldProfileLocks.getStore() ?? []).filter((ownership) => ownership.active);
  if (held.some((ownership) => ownership.lockPath === lockPath)) return action();
  const release = await acquireProfileLock(normalizedProfile, options);
  const ownership: HeldProfileLock = { lockPath, active: true };
  try {
    return await heldProfileLocks.run([...held, ownership], action);
  } finally {
    ownership.active = false;
    await release();
  }
}

/**
 * Appends a record or replaces the existing record with the supplied explicit
 * key. The extractor is supplied by the owning store so state.ts never needs
 * to know permission-request or delegation record shapes.
 */
export async function upsertProfileRecord<T>(
  profile: string,
  store: Exclude<ProfileStoreName, "session">,
  key: string,
  record: T,
  getKey: (candidate: T) => string | undefined,
  options: ProfileLockOptions = {},
): Promise<T[]> {
  if (!key) throw new TypeError("A non-empty record key is required.");

  return withProfileLock(profile, async () => {
    const current = (await readProfileStore<T>(profile, store)).records;
    const next = current.filter((candidate) => getKey(candidate) !== key);
    next.push(record);
    await writeJsonAtomic(profileStorePath(profile, store), next);
    await writeFormatOneMetadata(profile, store);
    return next;
  }, options);
}

/**
 * Performs a typed read-modify-write of a legacy array store under the one
 * per-profile lock. The payload stays an array and the sibling metadata stays
 * format 1, so existing CLI readers keep their byte/layout contract.
 */
export async function updateProfileStore<T, Result>(
  profile: string,
  store: Exclude<ProfileStoreName, "session">,
  update: (
    records: readonly T[],
  ) => Promise<{ readonly records: readonly T[]; readonly result: Result }> | {
    readonly records: readonly T[];
    readonly result: Result;
  },
  options: ProfileLockOptions = {},
): Promise<Result> {
  return withProfileLock(
    profile,
    () => updateProfileStoreWhileLocked(profile, store, update),
    options,
  );
}

/** The caller must already own this profile's lock. */
async function updateProfileStoreWhileLocked<T, Result>(
  profile: string,
  store: Exclude<ProfileStoreName, "session">,
  update: (
    records: readonly T[],
  ) => Promise<{ readonly records: readonly T[]; readonly result: Result }> | {
    readonly records: readonly T[];
    readonly result: Result;
  },
): Promise<Result> {
  const current = await readProfileStore<T>(profile, store);
  const next = await update(current.records);
  await writeJsonAtomic(profileStorePath(profile, store), next.records);
  await writeFormatOneMetadata(profile, store);
  return next.result;
}

export async function writeSession<T extends object>(
  profile: string,
  session: T,
  options: ProfileLockOptions = {},
): Promise<void> {
  await withProfileLock(profile, async () => {
    await readStoreMetadata(profile, "session");
    await writeJsonAtomic(sessionPath(profile), session);
    await writeFormatOneMetadata(profile, "session");
  }, options);
}

export async function removeSession(
  profile: string,
  options: ProfileLockOptions = {},
): Promise<void> {
  await withProfileLock(profile, async () => {
    await readStoreMetadata(profile, "session");
    await rm(sessionPath(profile), { force: true });
  }, options);
}

async function writeFormatOneMetadata(profile: string, store: ProfileStoreName): Promise<void> {
  await writeJsonAtomic(profileStoreMetadataPath(profile, store), { formatVersion: 1 });
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

  await mkdir(profilePath(profile), { recursive: true, mode: PRIVATE_DIR_MODE });
  // Every store write takes this lock: tighten the tree older releases
  // created 0775 before writing sessions or delegations into it.
  for (const directory of [tinycloudHomePath(), profilesPath(), profilePath(profile)]) {
    await chmod(directory, PRIVATE_DIR_MODE);
  }

  while (true) {
    try {
      await mkdir(lockPath);
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

/**
 * A lock directory whose holder crashed between `mkdir` and publishing its
 * owner file. A live acquirer publishes within milliseconds, so an empty
 * directory older than the stale threshold is dead; `rmdir` removes it only
 * while it is still empty, so a late owner file keeps the lock.
 */
async function recoverOwnerlessLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs < staleAfterMs) return false;
    await rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function recoverStaleLock(profile: string, lockPath: string, staleAfterMs: number): Promise<boolean> {
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readJson<{ pid?: unknown; createdAt?: unknown; token?: unknown }>(ownerPath)
    .catch(() => null);
  if (owner === null) return recoverOwnerlessLock(lockPath, staleAfterMs);
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
  if (process.env.NODE_ENV !== "test") return;
  const barrierDirectory = process.env[TEST_LOCK_RECOVERY_BARRIER_DIR];
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

function validateProfileName(profile: string): string {
  if (
    !profile ||
    profile === "." ||
    profile === ".." ||
    profile.includes("/") ||
    profile.includes("\\") ||
    profile.includes("\0")
  ) {
    throw new TypeError("Profile names must be non-empty path segments.");
  }
  return profile;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { DEFAULT_PROFILE };
