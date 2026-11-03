/**
 * The CLI's file adapter for the approval requester machine: `approval-pending.json` (version 2) of one profile.
 *
 * Every read and write runs under `ProfileManager.withLock`; every write is atomic and durable (`writeJsonDurable`: temp file,
 * fsync, rename, fsync of the directory; 0600 in a 0700 directory), so a kill at any point leaves the old file or the new one.
 * Reads go through `parseApprovalFile`: the CLI's version 1 array is migrated (written back as version 2 on the first write
 * that needs one), an entry that cannot be read is quarantined with its raw content (never deleted), a file that is not JSON is
 * set aside whole as `approval-pending.json.corrupt-<time>` (0600), and a file written by a newer client is refused untouched.
 * `sweepApprovalFile` runs on every load: an entry past its purge time leaves the file with its keys.
 *
 * An entry holds private keys. Nothing here prints, logs or copies one: a warning names the file, never its contents.
 */
import { chmod, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { profilePath } from "@tinycloud/operations/state";
import {
  QUARANTINE_RETENTION_MS,
  parseApprovalFile,
  sweepApprovalFile,
  type ApprovalEntry,
  type ApprovalFile,
  type ApprovalStore,
  type QuarantinedEntry,
} from "@tinycloud/share-envelope/links";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { writeJsonDurable } from "../config/storage.js";
import { CLIError } from "../output/errors.js";

export const APPROVAL_STATE_FILE = "approval-pending.json";
const ASIDE_PREFIX = `${APPROVAL_STATE_FILE}.corrupt-`;
/** `writeJsonDurable` names its temp file `.<file>.<pid>.<uuid>.tmp`. */
const TEMP_PREFIX = `.${APPROVAL_STATE_FILE}.`;
const isLeftover = (name: string) => name.startsWith(ASIDE_PREFIX) || (name.startsWith(TEMP_PREFIX) && name.endsWith(".tmp"));

export interface ApprovalState {
  readonly entries: ApprovalEntry[];
  readonly unrecognized: QuarantinedEntry[];
}
export interface ApprovalStateOptions {
  /** The clock the sweep uses; default the real one. */
  readonly now?: number;
}

const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
/** How many entries the file on disk already holds in `unrecognized`: a read that finds more has quarantined something new and must write it back. */
function storedQuarantineCount(raw: unknown): number {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("unrecognized" in raw)) return 0;
  return Array.isArray(raw.unrecognized) ? raw.unrecognized.length : 0;
}
const emptyFile = (): ApprovalFile => ({ version: 2, entries: [], unrecognized: [] });

/**
 * Set-aside copies and a killed writer's temp file may hold keys and carry no expiry to read: they are purged once they are older than
 * the longest request life plus retention. (A temp file of a writer that is still running is seconds old and stays.)
 */
async function purgeLeftovers(directory: string, now: number): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if (isMissing(error)) return; throw error; }
  for (const name of names.filter(isLeftover)) {
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs >= QUARANTINE_RETENTION_MS) await rm(join(directory, name), { force: true });
  }
}

/** Move a file that is not a pending-approval file out of the way, whole and 0600, and say so without quoting it. */
async function setAside(path: string, now: number): Promise<void> {
  const aside = `${path}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  await rename(path, aside);
  await chmod(aside, 0o600);
  process.stderr.write(`warning: ${APPROVAL_STATE_FILE} could not be read; it was moved to ${aside} and a new request will be made if one is needed.\n`);
}

interface Loaded {
  readonly file: ApprovalFile;
  /** The file on disk differs from `file` (a sweep, or entries newly quarantined): write it back. */
  readonly changed: boolean;
}

/**
 * CLI 1.6.x stored `relayPrivateKey` as Node's ECDH returned it: without its leading zero byte for 1 key in 256, so 31 bytes. The version 2
 * schema wants 32. The same scalar, left-padded with zeros, is what the entry holds (and what opens its result), so a pending approval is
 * migrated, not quarantined for a key that is merely short.
 */
function padLegacyRelayKeys(raw: unknown): unknown {
  const pad = (entry: unknown): unknown => {
    if (typeof entry !== "object" || entry === null || !("version" in entry) || entry.version !== 1) return entry;
    if (!("relayPrivateKey" in entry) || typeof entry.relayPrivateKey !== "string") return entry;
    const bytes = Buffer.from(entry.relayPrivateKey, "base64url");
    if (bytes.length === 0 || bytes.length >= 32) return entry;
    return { ...entry, relayPrivateKey: Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]).toString("base64url") };
  };
  return Array.isArray(raw) ? raw.map(pad) : pad(raw);
}

/** Read, migrate in memory and sweep. Call under the profile lock. */
async function readLocked(profile: string, now: number): Promise<Loaded> {
  const directory = profilePath(profile);
  const path = join(directory, APPROVAL_STATE_FILE);
  await purgeLeftovers(directory, now);
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if (isMissing(error)) return { file: emptyFile(), changed: false };
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    await setAside(path, now);
    return { file: emptyFile(), changed: false };
  }
  const parsed = parseApprovalFile(padLegacyRelayKeys(raw), { now });
  if (parsed.kind === "corrupt") {
    await setAside(path, now);
    return { file: emptyFile(), changed: false };
  }
  if (parsed.kind === "newer") {
    throw new CLIError("APPROVAL_STATE_UNREADABLE",
      `${APPROVAL_STATE_FILE} was written by a newer tc (file version ${parsed.version}) and was not touched. Use that tc or a newer one, or move the file aside, then run the command again.`,
      ExitCode.ERROR);
  }
  const stored = storedQuarantineCount(raw);
  const swept = sweepApprovalFile(parsed.file, now);
  return { file: swept.file, changed: swept.file !== parsed.file || swept.file.unrecognized.length > stored };
}

const write = async (profile: string, file: ApprovalFile) => {
  const directory = await ProfileManager.ensureProfileDir(profile);
  await writeJsonDurable(join(directory, APPROVAL_STATE_FILE), file);
};

async function hasState(profile: string): Promise<boolean> {
  const names = await readdir(profilePath(profile)).catch((error: unknown) => { if (isMissing(error)) return []; throw error; });
  return names.some((name) => name === APPROVAL_STATE_FILE || isLeftover(name));
}

/** The pending approvals of a profile: migrated, swept and quarantined. Writes only when the sweep or a quarantine changed the file. */
export async function loadApprovals(profile: string, options: ApprovalStateOptions = {}): Promise<ApprovalState> {
  if (!(await hasState(profile))) return { entries: [], unrecognized: [] };
  const now = options.now ?? Date.now();
  return ProfileManager.withLock(profile, async () => {
    const { file, changed } = await readLocked(profile, now);
    if (changed) await write(profile, file);
    return { entries: file.entries, unrecognized: file.unrecognized };
  }, { requireProfile: true });
}

/** Change the entries under the lock and write version 2 durably. The only writer of the file. */
export async function updateApprovals(profile: string, update: (entries: ApprovalEntry[]) => ApprovalEntry[], options: ApprovalStateOptions = {}): Promise<ApprovalState> {
  const now = options.now ?? Date.now();
  return ProfileManager.withLock(profile, async () => {
    const { file } = await readLocked(profile, now);
    const next: ApprovalFile = { version: 2, entries: update([...file.entries]), unrecognized: file.unrecognized };
    await write(profile, next);
    return { entries: next.entries, unrecognized: next.unrecognized };
  }, { requireProfile: true });
}

/** The machine driver's store over one profile's file. `now` is the run's clock, so a sweep and the machine agree. */
export function fileApprovalStore(profile: string, clock: { readonly now?: () => number } = {}): ApprovalStore {
  const now = () => (clock.now ?? Date.now)();
  return {
    async read(requestId) {
      return (await loadApprovals(profile, { now: now() })).entries.find((entry) => entry.requestId === requestId);
    },
    async write(entry) {
      await updateApprovals(profile, (entries) => entries.some((item) => item.requestId === entry.requestId)
        ? entries.map((item) => item.requestId === entry.requestId ? entry : item)
        : [...entries, entry], { now: now() });
    },
    async remove(requestId) {
      await updateApprovals(profile, (entries) => entries.filter((item) => item.requestId !== requestId), { now: now() });
    },
  };
}

/** Sign-out: remove the file, the quarantine inside it, every set-aside copy and a killed writer's temp file, with every key they hold. The caller holds the profile lock. */
export async function removeApprovalState(profile: string): Promise<void> {
  const directory = profilePath(profile);
  await rm(join(directory, APPROVAL_STATE_FILE), { force: true });
  const names = await readdir(directory).catch((error: unknown) => { if (isMissing(error)) return []; throw error; });
  for (const name of names.filter(isLeftover)) await rm(join(directory, name), { force: true });
}
