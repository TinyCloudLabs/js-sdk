import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const DEFAULT_PROFILE = "default";
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;
const TEST_LOCK_CONTENTION_SIGNAL_PATH = "TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH";

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
  const home = process.env.TC_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, ".tinycloud");
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

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, contents, "utf8");
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
 * profile stores. A stale lock is moved out of the way before deletion so a
 * concurrently acquired replacement can never be removed accidentally.
 */
export async function withProfileLock<T>(
  profile: string,
  action: () => Promise<T>,
  options: ProfileLockOptions = {},
): Promise<T> {
  const normalizedProfile = validateProfileName(profile);
  const release = await acquireProfileLock(normalizedProfile, options);
  try {
    return await action();
  } finally {
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
  return withProfileLock(profile, async () => {
    const current = await readProfileStore<T>(profile, store);
    const next = await update(current.records);
    await writeJsonAtomic(profileStorePath(profile, store), next.records);
    await writeFormatOneMetadata(profile, store);
    return next.result;
  }, options);
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

  await mkdir(profilePath(profile), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeJsonAtomic(profileLockMetadataPath(profile), {
          pid: process.pid,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isLockAlreadyHeld(error)) throw error;
      await signalTestLockContention(profile);
    }

    if (await recoverStaleLock(lockPath, staleAfterMs)) continue;

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new ProfileLockTimeoutError(profile, timeoutMs);
    }
    await sleep(Math.min(retryMs, timeoutMs - elapsedMs));
  }
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

async function recoverStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  if (!(await isStaleLock(lockPath, staleAfterMs))) return false;

  const quarantinedPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinedPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    return false;
  }
  await rm(quarantinedPath, { recursive: true, force: true });
  return true;
}

async function isStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  const now = Date.now();
  const owner = await readJson<{ pid?: unknown; createdAt?: unknown }>(join(lockPath, "owner.json"))
    .catch(() => null);
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
