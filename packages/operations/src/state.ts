import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
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
const TEST_LOCK_OWNERLESS_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_OWNERLESS_BARRIER_DIR";
const TEST_LOCK_PUBLISH_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_PUBLISH_BARRIER_DIR";
const TEST_LOCK_RELEASE_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_RELEASE_BARRIER_DIR";
const TEST_LOCK_CLAIM_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_CLAIM_BARRIER_DIR";
const TEST_LOCK_CLAIMED_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_CLAIMED_BARRIER_DIR";
const TEST_LOCK_VERIFIED_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_VERIFIED_BARRIER_DIR";
const TEST_LOCK_MOVED_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_MOVED_BARRIER_DIR";
const TEST_LOCK_TURN_PUBLISH_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_TURN_PUBLISH_BARRIER_DIR";
const TEST_LOCK_TURN_SETTLE_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_TURN_SETTLE_BARRIER_DIR";
const TEST_LOCK_TURN_COLLECT_BARRIER_DIR = "TC_TEST_PROFILE_LOCK_TURN_COLLECT_BARRIER_DIR";
/** One acquisition of a profile lock; `active` is cleared before release. */
interface HeldProfileLock {
  readonly lockPath: string;
  /** The number of the turn this acquisition holds (see acquireTurn). */
  readonly turnSlot: number;
  /** A deletion of the profile ran while this acquisition waited for the lock. */
  readonly deletedWhileWaiting: boolean;
  active: boolean;
}
/**
 * Async context shared by every copy of this module in the process. Each
 * bundled operations entry point (`state`, `delegation-binding`, the root)
 * carries its own copy, so module-level context would make lock reentrancy and
 * the invocation state root stop at an entry-point boundary.
 * Each key is independently versioned for the shape and meaning of the
 * value it stores. Held-lock entries gained `turnSlot` and
 * `deletedWhileWaiting` in TC-633, so `.v2` must not read TC-602's `.v1`
 * entries. The invocation root remains a string path with unchanged
 * semantics and stays `.v1`. Relinquished turn tokens use a separate
 * versioned process-wide key: only an explicitly given-up turn of this PID
 * may be settled across separately bundled entry points.
 */
function processWideContext<T>(key: string): AsyncLocalStorage<T> {
  const registry = globalThis as unknown as Record<symbol, AsyncLocalStorage<T> | undefined>;
  return registry[Symbol.for(key)] ??= new AsyncLocalStorage<T>();
}
const invocationStateRoot = processWideContext<string>("tinycloud.operations.invocationStateRoot.v1");
/** Profile lock acquisitions held by the current async call chain (see withProfileLock). */
const heldProfileLocks = processWideContext<readonly HeldProfileLock[]>("tinycloud.operations.heldProfileLocks.v2");

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

  /** `detail` names the cause when it is not simply another process holding the lock. */
  constructor(profile: string, timeoutMs: number, detail?: string) {
    super(`Timed out waiting for the profile lock for "${profile}" after ${timeoutMs}ms.${detail ? ` ${detail}` : ""}`);
    this.name = "ProfileLockTimeoutError";
  }
}

/**
 * A store write that waited for the profile lock while a deletion of that
 * profile held it, and found no profile settings once it got the lock. The
 * write is refused rather than recreating a profile with only a session or
 * store in it.
 */
export class ProfileDeletedError extends Error {
  readonly code = "PROFILE_NOT_FOUND";

  constructor(profile: string) {
    super(`Profile "${profile}" was deleted while this change waited for its lock, so the change was not written.`);
    this.name = "ProfileDeletedError";
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
 * The turn lock of a profile (see acquireTurn). It lives outside the profile
 * directory, so neither a profile deletion nor an older release's cleanup
 * removes it.
 */
export function profileTurnLockPath(profile: string): string {
  return join(tinycloudHomePath(), "profile-locks", validateProfileName(profile));
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
  await replaceJson(filePath, value, false);
}

/**
 * writeJsonAtomic; `durable` also flushes the data to disk before the rename,
 * so a crash or power loss leaves the old record or the new one, never a
 * truncated one (for lock records, whose damage would stop every writer).
 */
async function replaceJson(filePath: string, value: unknown, durable: boolean): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    if (durable) await writeFileDurably(temporaryPath, contents);
    else await writeFile(temporaryPath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Creates a file (exclusively) and, when it has contents, flushes them to disk. */
async function writeFileDurably(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", PRIVATE_FILE_MODE);
  try {
    if (contents) {
      await handle.writeFile(contents, "utf8");
      await handle.datasync();
    }
  } finally {
    await handle.close();
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
 * Runs a small critical section under the one lock shared by all profile
 * stores (see acquireProfileLock). Lock release verifies its ownership token
 * before removing the exact metadata instance it acquired.
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
  const acquired = await acquireProfileLock(normalizedProfile, options);
  const ownership: HeldProfileLock = {
    lockPath,
    turnSlot: acquired.turnSlot,
    deletedWhileWaiting: acquired.deletedWhileWaiting,
    active: true,
  };
  try {
    return await heldProfileLocks.run([...held, ownership], action);
  } finally {
    ownership.active = false;
    await acquired.release();
    // Taking the lock recreated the deleted profile's directory; remove it
    // again unless something was written into it (rmdir needs it empty).
    if (acquired.deletedWhileWaiting) await rmdir(profilePath(normalizedProfile)).catch(() => undefined);
  }
}

/**
 * Records, inside a profile deletion's critical section and after its files
 * are gone, that the profile was deleted, with the number of the deleting
 * turn. A store write whose wait overlapped that turn (it arrived before the
 * deletion released the lock, whether before or after this record) then
 * refuses (ProfileDeletedError) instead of recreating a profile with only a
 * session or store in it. The caller must hold the profile's lock.
 */
export async function recordProfileDeletion(profile: string): Promise<void> {
  const lockPath = profileLockPath(profile);
  const ownership = (heldProfileLocks.getStore() ?? []).find((candidate) => candidate.active && candidate.lockPath === lockPath);
  if (!ownership) throw new Error(`Recording the deletion of profile "${profile}" requires holding its lock.`);
  await replaceJson(join(profileTurnLockPath(profile), "deleted.json"), { slot: ownership.turnSlot }, true);
}

/**
 * Refuses a write that would recreate a profile deleted while this critical
 * section waited for the lock (ProfileDeletedError). Every writer of profile
 * state other than the profile settings themselves calls this inside its
 * critical section, before writing. The caller must hold the profile's lock.
 */
export async function refuseWriteToDeletedProfile(profile: string): Promise<void> {
  const lockPath = profileLockPath(profile);
  const ownership = (heldProfileLocks.getStore() ?? []).find((candidate) => candidate.active && candidate.lockPath === lockPath);
  if (!ownership?.deletedWhileWaiting) return;
  // Recreated meanwhile (or by this critical section): writing is fine.
  if (await exists(profileConfigPath(profile))) return;
  throw new ProfileDeletedError(profile);
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
    await refuseWriteToDeletedProfile(profile);
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
  await refuseWriteToDeletedProfile(profile);
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
    await refuseWriteToDeletedProfile(profile);
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

interface AcquiredProfileLock {
  readonly deletedWhileWaiting: boolean;
  readonly turnSlot: number;
  release(): Promise<void>;
}

interface LockDeadline {
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly retryMs: number;
}

/**
 * Takes a profile's lock in two layers:
 *
 * 1. The turn lock (acquireTurn), used by this release and later ones. It
 *    decides nothing from elapsed time, so a process paused anywhere, for
 *    any length of time, cannot let a second holder in.
 * 2. Holding a turn, the `.lock` directory every older release uses
 *    (publishProfileLock), so they keep excluding this release and it them.
 *    Only one process of this release at a time acquires, recovers or
 *    releases `.lock`.
 *
 * Also reports whether a profile deletion (recordProfileDeletion) ran while
 * this acquisition waited.
 */
async function acquireProfileLock(
  profile: string,
  options: ProfileLockOptions,
): Promise<AcquiredProfileLock> {
  const deadline: LockDeadline = {
    startedAt: Date.now(),
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    retryMs: options.retryMs ?? DEFAULT_LOCK_RETRY_MS,
  };
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = profileLockPath(profile);
  const turnDirectory = profileTurnLockPath(profile);

  const directory = profilePath(profile);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  await mkdir(dirname(turnDirectory), { recursive: true, mode: PRIVATE_DIR_MODE });
  // Every store write takes this lock: tighten the tree older releases
  // created 0775 before writing sessions or delegations into it.
  for (const path of [tinycloudHomePath(), profilesPath(), directory]) {
    await chmod(path, PRIVATE_DIR_MODE).catch((error: unknown) => {
      // A profile deletion can remove the profile directory right after the
      // mkdir above; the lock attempt below recreates it 0700.
      if (path !== directory || !isErrno(error, "ENOENT")) throw error;
    });
  }

  const { turn, firstWaitedTurn } = await acquireTurn(profile, turnDirectory, deadline);
  try {
    // An unreadable deletion record is ignored rather than failing every
    // acquisition; it is written durably, so only damage makes it so.
    const deletion = await readJson<{ slot?: unknown }>(join(turnDirectory, "deleted.json")).catch(() => null);
    const deletedWhileWaiting = typeof deletion?.slot === "number" && deletion.slot >= firstWaitedTurn;
    while (true) {
      const token = randomUUID();
      if (await publishProfileLock(profile, lockPath, token)) {
        return {
          deletedWhileWaiting,
          turnSlot: turn.slot,
          release: async () => {
            try {
              await releaseProfileLock(profile, lockPath, token);
            } finally {
              await releaseTurn(profile, turn);
            }
          },
        };
      }
      await signalTestLockContention(profile);
      if (await recoverStaleLock(profile, lockPath, staleAfterMs)) continue;
      await waitOrTimeOut(profile, deadline);
    }
  } catch (error) {
    await releaseTurn(profile, turn);
    throw error;
  }
}

/** Throws once the acquisition's time is up; `detail` explains a damaged turn lock. */
function checkDeadline(profile: string, deadline: LockDeadline, detail?: string): void {
  if (Date.now() - deadline.startedAt >= deadline.timeoutMs) {
    throw new ProfileLockTimeoutError(profile, deadline.timeoutMs, detail);
  }
}

/** Sleeps one retry interval, or throws once the acquisition's time is up. */
async function waitOrTimeOut(profile: string, deadline: LockDeadline, detail?: string): Promise<void> {
  checkDeadline(profile, deadline, detail);
  await sleep(Math.min(deadline.retryMs, deadline.timeoutMs - (Date.now() - deadline.startedAt)));
}

/** One granted turn of the turn lock. */
interface Turn {
  readonly directory: string;
  readonly slot: number;
  readonly token: string;
}

/** A turn as recorded on disk. */
interface TurnState {
  readonly slot: number;
  readonly token: string;
  readonly pid: number;
  /** The token of the turn before it that its creator observed; null for turn 0. */
  readonly after: string | null;
  readonly held: boolean;
  readonly done: boolean;
}

/** Turn directory names: decimal turn numbers. */
const TURN = /^(?:0|[1-9][0-9]*)$/;

/**
 * Tokens of turns this process published and then gave up (a marker write or
 * a read failed after publication): the positive evidence that lets this
 * process settle a turn of its own PID. A live process's turn that is not in
 * here is never settled by it, so a module instance that cannot see another
 * instance's set (another bundled copy of this package) waits rather than
 * settling a turn that copy still holds.
 *
 * One set per process, not per module instance: the package's entry points
 * (state, index, artifacts, cli-runtime; ESM and CJS) each bundle their own
 * copy of this module, and one process may load several. The key is
 * versioned so that a release changing what the set holds uses a new one.
 */
const relinquishedTurns: Set<string> =
  (globalThis as unknown as Record<symbol, Set<string> | undefined>)[Symbol.for("tinycloud.operations.relinquishedProfileTurns.v1")] ??=
    new Set<string>();

/** Marker writes are retried this many times, after these delays (ms), before giving up. */
const MARKER_RETRY_DELAYS_MS = [10, 50, 250];
/** A given-up turn is settled in the background every second for up to five minutes. */
const SETTLE_RETRY_MS = 1_000;
const SETTLE_RETRIES = 300;

/**
 * The turn lock: mutual exclusion among processes of this release that does
 * not depend on how long any of them is paused. It uses only `mkdir`,
 * `rename`, exclusive file creation, and a check that a holder's PID is gone
 * (as `.lock` recovery always has), so it needs no hard links.
 *
 * Turns are numbered directories in profileTurnLockPath(profile). Turn n has
 * `owner.json` ({ pid, createdAt, token, after }), where `after` is the token
 * of the turn n-1 its creator observed, and gains `<token>.held` when granted
 * and `<token>.done` when over. Markers name the turn's own token, so one
 * written late into a recreated directory of the same number means nothing.
 *
 * - A turn is published by renaming a fully written staging directory to
 *   `n`, which fails while `n` exists (rename never replaces a non-empty
 *   directory, and turn directories are never empty). The turn directory
 *   itself is published the same way, with a granted, finished turn 0.
 * - A process takes turn n only after reading turn n-1 granted and done.
 *   Once `n` is published it checks that turn n-1 is still the one it read
 *   (same token, granted, done) and only then writes `held`; otherwise the
 *   turn is void: it writes `done` alone and starts over.
 * - Turns are removed by renaming them aside: a void turn at any time, a
 *   granted one only once no older turn is left and turn n+1 is granted and
 *   done. The latest turn is never removed.
 *
 * Why at most one granted turn is ever not done: a removed number can be
 * published again, but turn n-1 is always removed before turn n, so a
 * process whose stale read led it to republish n finds n-1 gone or holding
 * another token, and its turn is void. A process that finds n-1 as it read
 * it published `n` for the first time, so it is the only process granted n,
 * and n-1 was done before. A turn is marked done only by its holder, or by
 * another process once the holder's PID is gone (or by its own process,
 * once it has explicitly given that turn up); a paused holder is alive.
 * A turn is voided only on definite evidence (the turn it follows is gone or
 * holds another token), never because a read failed. Nothing above is
 * decided from elapsed time.
 *
 * Returns the turn and the number of the first turn this acquisition waited
 * on: the latest turn when it first looked if that was not done yet, else
 * the next one.
 */
async function acquireTurn(
  profile: string,
  directory: string,
  deadline: LockDeadline,
): Promise<{ turn: Turn; firstWaitedTurn: number }> {
  let firstWaitedTurn: number | undefined;
  // Why the turn lock looks damaged, as of the last look, for the timeout message.
  let problem: string | undefined;
  const damaged = (what: string) =>
    `The turn lock ${directory} ${what}, so no process can take it. ` +
    `If no tc or MCP process is using profile "${profile}", remove that directory.`;
  for (let first = true; ; first = false) {
    if (!first) checkDeadline(profile, deadline, problem);
    problem = undefined;
    const latest = await readLatestTurn(directory);
    if (latest === "missing") {
      await createTurnDirectory(directory);
      continue;
    }
    if (latest === "empty") {
      // Usually a listing that straddled a turn's publication and an older
      // turn's removal (readdir is not a snapshot); damaged if it persists.
      problem = damaged("has no turns");
      await waitOrTimeOut(profile, deadline, problem);
      continue;
    }
    if (latest === null) continue;
    if (typeof latest === "number") {
      problem = damaged(`has an unreadable turn ${latest}`);
      await waitOrTimeOut(profile, deadline, problem);
      continue;
    }
    firstWaitedTurn ??= latest.done ? latest.slot + 1 : latest.slot;
    if (latest.held && latest.done) {
      const turn = await takeTurn(profile, directory, latest);
      if (turn !== null) return { turn, firstWaitedTurn };
      await waitOrTimeOut(profile, deadline);
    } else if (latest.done) {
      problem = damaged(`ends with turn ${latest.slot}, which was never granted`);
      await waitOrTimeOut(profile, deadline, problem);
    } else if (latest.pid === process.pid ? relinquishedTurns.has(latest.token) : !isProcessAlive(latest.pid)) {
      await waitForTestBarrier(TEST_LOCK_TURN_SETTLE_BARRIER_DIR, profile);
      await settleAbandonedTurn(directory, latest);
      relinquishedTurns.delete(latest.token);
    } else {
      await signalTestLockContention(profile);
      await waitOrTimeOut(profile, deadline);
    }
  }
}

/**
 * The highest-numbered turn: its state, its number if it is damaged, null if
 * it went away while being read.
 */
async function readLatestTurn(directory: string): Promise<TurnState | number | "missing" | "empty" | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
  const slots = names.filter((name) => TURN.test(name)).map(Number);
  if (slots.length === 0) return "empty";
  const slot = Math.max(...slots);
  const turn = await readTurn(directory, slot);
  return turn === "damaged" ? slot : turn;
}

/**
 * Turn `slot` as recorded now; null if it is gone; "damaged" if its owner
 * record is missing or unreadable (turns are renamed into place and aside
 * whole, with their owner record written durably). Any other read error is
 * thrown: it says nothing about the turn. `done` is read before `held`,
 * which every writer creates first, so a turn read as done is never misread
 * as void.
 */
async function readTurn(directory: string, slot: number): Promise<TurnState | "damaged" | null> {
  const path = join(directory, String(slot));
  let text: string;
  try {
    text = await readFile(join(path, "owner.json"), "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) throw error;
    return await exists(path) ? "damaged" : null;
  }
  let owner: { pid?: unknown; token?: unknown; after?: unknown } | null;
  try {
    owner = JSON.parse(text) as typeof owner;
  } catch {
    return "damaged";
  }
  if (owner === null || typeof owner !== "object" || typeof owner.token !== "string" || typeof owner.pid !== "number") {
    return "damaged";
  }
  const done = await exists(join(path, `${owner.token}.done`));
  const held = await exists(join(path, `${owner.token}.held`));
  return {
    slot,
    token: owner.token,
    pid: owner.pid,
    after: typeof owner.after === "string" ? owner.after : null,
    held,
    done,
  };
}

/**
 * Whether turn `slot` is still the granted, finished turn with `token`. False
 * only on definite evidence: it is gone, or holds another token. Throws if it
 * cannot be read, or is damaged, so the caller leaves its own turn undecided.
 */
async function isFinishedTurn(directory: string, slot: number, token: string): Promise<boolean> {
  const turn = await readTurn(directory, slot);
  if (turn === "damaged") throw new Error(`Turn ${slot} of the turn lock ${directory} is unreadable.`);
  return turn !== null && turn.token === token && turn.held && turn.done;
}

/**
 * Publishes the turn after `latest` and claims it. Null if another process
 * published that number first, or the turn is void. If a step after
 * publication fails, the turn is handed to settleOwnTurn and the error thrown.
 */
async function takeTurn(profile: string, directory: string, latest: TurnState): Promise<Turn | null> {
  const token = randomUUID();
  const slot = latest.slot + 1;
  const path = join(directory, String(slot));
  const owner = { pid: process.pid, createdAt: new Date().toISOString(), token, after: latest.token };
  let published = false;
  try {
    published = await publishDirectory(
      join(directory, `.stage-${process.pid}-${token}`),
      path,
      { "owner.json": `${JSON.stringify(owner, null, 2)}\n` },
      () => waitForTestBarrier(TEST_LOCK_TURN_PUBLISH_BARRIER_DIR, profile),
    );
    if (published && await isFinishedTurn(directory, latest.slot, latest.token) && await markTurn(path, token, "held")) {
      return { directory, slot, token };
    }
    if (published) await markTurn(path, token, "done");
    return null;
  } catch (error) {
    if (published) settleOwnTurn(directory, slot, token);
    throw error;
  }
}

/**
 * Finishes the turn of a process that is gone (or one this process gave up).
 * A turn its creator never got to grant is granted first if the turn before
 * it is still the one its creator read (the check the creator would have
 * made; that turn cannot have been removed, since that needs this turn
 * done), and left void only if it definitely is not.
 */
async function settleAbandonedTurn(directory: string, abandoned: TurnState): Promise<void> {
  const path = join(directory, String(abandoned.slot));
  if (!abandoned.held && abandoned.after !== null &&
    await isFinishedTurn(directory, abandoned.slot - 1, abandoned.after)) {
    await markTurn(path, abandoned.token, "held");
  }
  await markTurn(path, abandoned.token, "done");
}

/**
 * Settles a turn this process published but could not grant or finish (a
 * marker write or a read failed). Other processes wait on this live PID, so
 * it is retried in the background until it succeeds or the turn is settled
 * otherwise (by this process's next acquisition, or by another process once
 * this one has exited). The timer does not keep the process alive.
 */
function settleOwnTurn(directory: string, slot: number, token: string, retries = SETTLE_RETRIES): void {
  relinquishedTurns.add(token);
  void (async () => {
    try {
      const turn = await readTurn(directory, slot);
      if (turn !== null && turn !== "damaged" && turn.token === token && !turn.done) await settleAbandonedTurn(directory, turn);
      relinquishedTurns.delete(token);
    } catch {
      // Still relinquished: this process's next acquisition settles it too.
      if (retries > 0) setTimeout(() => settleOwnTurn(directory, slot, token, retries - 1), SETTLE_RETRY_MS).unref();
    }
  })();
}

/**
 * Creates `<token>.<kind>` in a turn directory; false if the directory is
 * gone. Other failures (a full disk, a permission error) are retried a few
 * times, then thrown.
 */
async function markTurn(path: string, token: string, kind: "held" | "done"): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(join(path, `${token}.${kind}`), "", { mode: PRIVATE_FILE_MODE, flag: "wx" });
      return true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) return true;
      if (isErrno(error, "ENOENT")) return false;
      if (attempt >= MARKER_RETRY_DELAYS_MS.length) throw error;
      await sleep(MARKER_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/** Creates the turn directory with a granted, finished turn 0, unless another process did. */
async function createTurnDirectory(directory: string): Promise<void> {
  const token = randomUUID();
  const owner = { pid: process.pid, createdAt: new Date().toISOString(), token, after: null };
  await publishDirectory(join(dirname(directory), `.stage-${basename(directory)}-${process.pid}-${token}`), directory, {
    "0/owner.json": `${JSON.stringify(owner, null, 2)}\n`,
    [`0/${token}.held`]: "",
    [`0/${token}.done`]: "",
  });
}

/**
 * Writes `files` (durably, when not empty) into a new staging directory and
 * renames it to `target`. False if `target` already exists (or the turn
 * directory is gone); the caller starts over. Nothing else removes a live
 * process's staging directory (see collectTurns), so `target` never appears
 * incomplete.
 */
async function publishDirectory(
  stage: string,
  target: string,
  files: Readonly<Record<string, string>>,
  beforeRename?: () => Promise<void>,
): Promise<boolean> {
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(stage, name)), { recursive: true, mode: PRIVATE_DIR_MODE });
      await writeFileDurably(join(stage, name), contents);
    }
    await beforeRename?.();
    await rename(stage, target);
    return true;
  } catch (error) {
    // ENOTEMPTY/EEXIST: `target` exists, though it may be gone again by now.
    // Windows reports an existing target directory as EPERM.
    if (["ENOTEMPTY", "EEXIST", "ENOENT"].some((code) => isErrno(error, code)) || await exists(target)) return false;
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Finishes this process's turn. If `done` cannot be written even after
 * retries, the critical section is still over and its writes stand: the turn
 * is handed to settleOwnTurn rather than failing the caller.
 */
async function releaseTurn(profile: string, turn: Turn): Promise<void> {
  try {
    await markTurn(join(turn.directory, String(turn.slot)), turn.token, "done");
  } catch {
    settleOwnTurn(turn.directory, turn.slot, turn.token);
    return;
  }
  await collectTurns(profile, turn).catch(() => undefined);
}

/**
 * Leftovers in a turn directory whose writer is gone: trash (a removed turn
 * renamed aside, garbage from then on), and staging directories and
 * deletion-record temporaries named after their writer's PID.
 */
function isAbandonedTurnEntry(name: string): boolean {
  if (name.startsWith(".trash-")) return true;
  const writer = /^\.(?:stage|deleted\.json)[-.]([0-9]+)[-.]/.exec(name)?.[1];
  return writer !== undefined && !isProcessAlive(Number(writer));
}

/** A turn directory's staging directory left beside it by a process that is gone. */
function isAbandonedTurnDirectoryStage(name: string): boolean {
  const writer = /^\.stage-.+-([0-9]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name)?.[1];
  return writer !== undefined && !isProcessAlive(Number(writer));
}

/**
 * Removes the turns before `turn`, which just finished: void turns, and
 * granted ones oldest first, each once no older turn is left and the next is
 * granted and done (see acquireTurn). A turn is renamed aside before it is
 * deleted, so its number is never an empty directory. A turn that is damaged
 * or cannot be read is left alone, and a read error stops the collection.
 * Leftovers of crashed processes go too, judged by PID, never by age:
 * removing a paused process's staging directory could publish an incomplete
 * turn.
 */
async function collectTurns(profile: string, turn: Turn): Promise<void> {
  for (const [directory, abandoned] of [
    [turn.directory, isAbandonedTurnEntry],
    [dirname(turn.directory), isAbandonedTurnDirectoryStage],
  ] as const) {
    for (const name of (await readdir(directory)).filter(abandoned)) {
      await rm(join(directory, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const older = (await readdir(turn.directory)).filter((name) => TURN.test(name)).map(Number)
    .filter((slot) => slot < turn.slot)
    .sort((left, right) => left - right);
  for (const slot of older) {
    const candidate = await readTurn(turn.directory, slot);
    if (candidate === null || candidate === "damaged" || !candidate.done) continue;
    if (candidate.held) {
      if (await exists(join(turn.directory, String(slot - 1)))) continue;
      const next = await readTurn(turn.directory, slot + 1);
      if (next === null || next === "damaged" || !next.held || !next.done) continue;
    }
    await waitForTestBarrier(TEST_LOCK_TURN_COLLECT_BARRIER_DIR, profile);
    const trash = join(turn.directory, `.trash-${randomUUID()}`);
    if (await rename(join(turn.directory, String(slot)), trash).then(() => true, () => false)) {
      await rm(trash, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * One attempt to take `.lock`, made while holding a turn. Nothing here
 * replaces an existing path:
 *
 * 1. `mkdir(.lock)` (never recursive) is exclusive, and is the primitive
 *    older releases use too, so they exclude each other.
 * 2. Ownership is published by `link`ing a fully written owner file (staged
 *    beside `.lock`, on the same filesystem) to `.lock/owner.json`. `link`
 *    fails with EEXIST if an owner exists, and with ENOENT if the directory
 *    was removed meanwhile (an aged ownerless-lock reclaim by an older
 *    release). Only a successful link holds the lock; on either failure
 *    nothing is released, since nothing was acquired, and the caller retries.
 *    On a filesystem without hard links (FAT/exFAT, some SMB mounts) the
 *    owner file is created in place with an exclusive create instead, with
 *    the same EEXIST/ENOENT outcomes. A reader may then briefly see it
 *    incomplete; every release treats an owner file it cannot parse as a
 *    held lock, and this release removes one only once it has aged (see
 *    isAbandonedOwner).
 *
 * A profile deletion removes the profile directory once it has released its
 * lock, so `mkdir(.lock)` can see ENOENT; the directory is recreated (0700)
 * and the caller retries within its deadline, as for a first write to a new
 * profile.
 *
 * Only one owner.json can exist at the lock path, and it is removed only by
 * its holder's release or by recovery of an abandoned holder, so at most one
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
  const ownerPath = join(lockPath, "owner.json");
  const staged = join(dirname(lockPath), `.lock-owner-${token}.tmp`);
  const owner = `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token }, null, 2)}\n`;
  try {
    await writeFile(staged, owner, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    try {
      await link(staged, ownerPath);
    } catch (error) {
      if (!lacksHardLinks(error)) throw error;
      await writeFile(ownerPath, owner, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    }
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
 * Errors `link` reports on a filesystem without hard links: EPERM (Linux
 * FAT/exFAT), ENOTSUP/EOPNOTSUPP (macOS FAT/exFAT, SMB), ENOSYS, EISDIR
 * (libuv's code for Windows' ERROR_INVALID_FUNCTION on FAT32), and EMLINK
 * (too many links), for which the same fallback is just as correct.
 */
const NO_HARD_LINK_ERRORS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR", "EMLINK"]);

function lacksHardLinks(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    NO_HARD_LINK_ERRORS.has(String((error as { code?: unknown }).code));
}

/**
 * Releases the lock if `.lock/owner.json` is still this acquisition's. No
 * one else can put an owner record there while it exists (owners are only
 * published into a directory their own `mkdir` created, and recovery
 * removes only an abandoned holder's record), so the record read is the one
 * unlinked.
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
 * Reclaims a `.lock` with no owner record, while holding a turn. A
 * `.recover-*` claim may contain a live legacy owner's record moved by a
 * no-hard-links recoverer just before it crashed. Restore that record first;
 * only orphaned claims holding dead or malformed records can be removed.
 * Otherwise the directory must be older than the stale threshold: one left
 * by a crash, or by an older release, whose `.stale-*` / `.release-*` claim
 * files are removed too. owner.json is never unlinked, and the directory
 * itself is only `rmdir`ed, which succeeds only while it is empty.
 *
 * Holding a turn, no other process of this release reclaims concurrently.
 * That closes the race in which two reclaimers' age checks let the later one
 * remove a directory a 1.0.0-beta.16-or-older release had just created,
 * which holds the lock from its `mkdir`. That race remains only if a
 * 1.0.0-beta.17 … 1.0.1-beta.4 release reclaims at the same moment, or the
 * older process stays paused between its `mkdir` and its owner write for
 * longer than the stale threshold; recoveryFenced bounds how stale this
 * process's age check can be.
 */
async function recoverOwnerlessLock(profile: string, lockPath: string, staleAfterMs: number): Promise<boolean> {
  let aged: boolean;
  try {
    const { mtimeMs } = await stat(lockPath);
    aged = Date.now() - mtimeMs >= staleAfterMs;
  } catch {
    return false;
  }
  const checkedAt = performance.now();
  await waitForTestBarrier(TEST_LOCK_OWNERLESS_BARRIER_DIR, profile);
  try {
    const entries = await readdir(lockPath);
    if (entries.includes("owner.json")) return false;
    const onlyOrphanedClaims = entries.length > 0 && entries.every((entry) => RECOVERY_CLAIM.test(entry));
    if (!onlyOrphanedClaims && (!aged || recoveryFenced(checkedAt, staleAfterMs))) return false;
    for (const name of entries.filter((entry) => RECOVERY_CLAIM.test(entry))) {
      const claimPath = join(lockPath, name);
      if (await hasLiveRecoveryOwner(claimPath)) {
        // The claim keeps the directory in place. Only the original mkdir
        // owner could publish owner.json here; never overwrite that record.
        if (!await exists(join(lockPath, "owner.json"))) await rename(claimPath, join(lockPath, "owner.json"));
        return false;
      }
      await rm(claimPath, { force: true });
    }
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

/** A no-hard-links claim may contain a live owner's record moved before a crash. */
async function hasLiveRecoveryOwner(claimPath: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(claimPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error; // An I/O failure is not evidence that the holder is gone.
  }
  let owner: unknown;
  try {
    owner = JSON.parse(contents);
  } catch {
    return false;
  }
  const pid = typeof owner === "object" && owner !== null && "pid" in owner ? owner.pid : null;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
}

/**
 * Whether an ownerless-reclaim decision made at `since` (a monotonic
 * timestamp) is too old to act on. The age check is only good for a while:
 * past half the stale threshold the reclaim starts over.
 */
function recoveryFenced(since: number, staleAfterMs: number): boolean {
  return performance.now() - since >= staleAfterMs / 2;
}

/** Claim files of older releases' stale recovery and (up to 1.0.0-beta.16) release. */
const ABANDONED_CLAIM = /^\.(?:release|stale)-[0-9a-f-]+\.json$/;
/**
 * Claim files of this release's stale recovery. Releases up to 1.0.1-beta.4
 * never remove them, which is what makes this recovery safe against them; a
 * recoverer that crashes leaves one that only a release with the turn lock
 * clears (see REFERENCE.md, "Profile lock").
 */
const RECOVERY_CLAIM = /^\.recover-[0-9a-f-]+\.json$/;
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
 * Removes an abandoned owner record (see isAbandonedOwner) and its `.lock`,
 * while holding a turn, so no other process of this release recovers,
 * reclaims or acquires `.lock` meanwhile.
 *
 * The record is claimed first: hard-linked to `.recover-<uuid>.json`, and the
 * claim compared with the exact bytes read. A record that replaced the
 * observed one is left in place. While the claim is inside `.lock`, the
 * directory cannot be removed and recreated: older releases never remove a
 * `.recover-*` claim (they clean up only their own claim names), and other
 * processes of this release are kept out by the turn lock. So no other owner
 * record can appear in it, and the unlink of owner.json can only remove the
 * claimed, dead record. A live record is never unlinked or moved. `.lock`
 * itself is removed only after this process's claim is unlinked from it,
 * which proves it is still the dead holder's directory; if the claim cannot
 * be made, `.lock` is left alone (it may be a directory a 1.0.0-beta.16-or-
 * older writer just created, which it holds from that `mkdir`). No step
 * depends on how long this process takes.
 *
 * Without hard links (where 1.0.0-beta.17 … 1.0.1-beta.4 cannot run at all),
 * the record is renamed into the claim instead, and put back if it is not
 * the observed one: one a 1.0.0-beta.16-or-older process published after
 * recovering the same lock at the same moment. The claim keeps `.lock` held
 * meanwhile, so no second writer gets in, but if that holder releases
 * between the two renames, the put-back restores a released record, and
 * `.lock` stays held until that PID is gone and the record is 30 s old.
 */
async function recoverStaleLock(profile: string, lockPath: string, staleAfterMs: number): Promise<boolean> {
  const ownerPath = join(lockPath, "owner.json");
  const observed = await readFile(ownerPath, "utf8").catch(() => null);
  if (observed === null) return recoverOwnerlessLock(profile, lockPath, staleAfterMs);
  if (!await isAbandonedOwner(observed, ownerPath, staleAfterMs)) return false;

  await waitForTestBarrier(TEST_LOCK_RECOVERY_BARRIER_DIR, profile);
  const claimPath = join(lockPath, `.recover-${randomUUID()}.json`);
  let moved = false;
  try {
    await link(ownerPath, claimPath);
  } catch (error) {
    // Gone or replaced already (another release recovered it): leave `.lock`.
    if (!lacksHardLinks(error)) return false;
    try {
      await rename(ownerPath, claimPath);
      moved = true;
    } catch {
      return false;
    }
  }
  if (moved) await waitForTestBarrier(TEST_LOCK_MOVED_BARRIER_DIR, profile);
  const sameInstance = await readFile(claimPath, "utf8").then((claimed) => claimed === observed, () => false);
  await waitForTestBarrier(TEST_LOCK_VERIFIED_BARRIER_DIR, profile);
  if (!sameInstance) {
    if (moved) {
      // No other owner.json can have appeared meanwhile: only a process
      // whose mkdir created this `.lock` publishes one, and it already has.
      await rename(claimPath, ownerPath).catch(() => undefined);
    } else {
      await unlink(claimPath).catch(() => undefined);
    }
    return false;
  }
  if (!moved) await rm(ownerPath, { force: true });
  await waitForTestBarrier(TEST_LOCK_CLAIM_BARRIER_DIR, profile);
  await waitForTestBarrier(TEST_LOCK_CLAIMED_BARRIER_DIR, profile);
  // Drop any claim a crashed recoverer of this release left, then this one.
  for (const name of (await readdir(lockPath).catch(() => [])).filter((entry) => RECOVERY_CLAIM.test(entry))) {
    if (join(lockPath, name) !== claimPath) await rm(join(lockPath, name), { force: true });
  }
  // Empty now, and still the dead holder's directory if this claim was in
  // it: remove it rather than leave an ownerless lock to age out.
  if (await unlink(claimPath).then(() => true, () => false)) await rmdir(lockPath).catch(() => undefined);
  await removeAgedOwnerFiles(lockPath, staleAfterMs);
  return true;
}

/**
 * Whether an owner record (its exact bytes, read from `ownerPath`) is
 * abandoned: a holder's whose PID is gone, older than the stale threshold;
 * or, if it is not a complete record, a file older than that threshold.
 * Every release publishes complete records (by link or rename) except this
 * one's no-hard-link fallback, which writes in place while holding a turn;
 * so an incomplete record seen while holding a turn was left by a crash.
 */
async function isAbandonedOwner(observed: string, ownerPath: string, staleAfterMs: number): Promise<boolean> {
  let owner: unknown;
  try {
    owner = JSON.parse(observed);
  } catch {
    owner = null;
  }
  if (typeof owner === "object" && owner !== null && "pid" in owner) {
    return isStaleOwner(owner as { pid?: unknown; createdAt?: unknown }, staleAfterMs);
  }
  const modifiedAt = await stat(ownerPath).then(({ mtimeMs }) => mtimeMs, () => Number.NaN);
  return Date.now() - modifiedAt >= staleAfterMs;
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

/** Whether `path` exists. Only ENOENT/ENOTDIR mean it does not; other errors are thrown. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return false;
    throw error;
  }
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
