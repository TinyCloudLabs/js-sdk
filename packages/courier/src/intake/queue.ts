import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CourierError } from '../errors.js';
import { isRecord } from '../a2a.js';

/**
 * Creates a directory and refuses anything that is not a real directory (a symlink in its place is refused). `mode`
 * applies only to a directory this call creates; an existing directory keeps its mode, so a provisioned root (for
 * example setgid 2750) is never rewritten.
 */
export function ensureRealDir(dir: string, mode: number): void {
  let existed = true;
  try {
    fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existed = false;
  }
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CourierError('unsafe-dir', 'queue or state path is not a real directory');
  }
  if (!existed && stat.uid === process.getuid?.() && (stat.mode & 0o7777) !== mode) fs.chmodSync(dir, mode);
}

/** Makes a link or rename in `dir` durable: the directory entry is fsynced, not only the file contents. */
function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes the full body to a same-directory temp file with the given mode, fsynced, and returns its path. */
function writeTemp(dir: string, name: string, body: string, mode: number): string {
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  return temp;
}

/**
 * Creates `dir/name` only if nothing is there yet (hard link of the temp file, which fails if the target exists, symlinks
 * included). Returns false when the target already exists, so a queued message is never overwritten.
 */
export function writeNew(dir: string, name: string, body: string, mode: number): boolean {
  const temp = writeTemp(dir, name, body, mode);
  try {
    fs.linkSync(temp, path.join(dir, name));
    fsyncDir(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Replaces `dir/name` atomically (temp file plus rename). Refuses to replace anything that is not a regular file. */
export function writeReplace(dir: string, name: string, body: string, mode: number): void {
  const target = path.join(dir, name);
  try {
    if (!fs.lstatSync(target).isFile()) throw new CourierError('unsafe-target', 'refusing to replace a non-regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = writeTemp(dir, name, body, mode);
  try {
    fs.renameSync(temp, target);
    fsyncDir(dir);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock or takeover guard with no readable pid that is older than this was abandoned by a crashed process. */
const LOCK_STALE_MS = 30_000;

function ageMs(file: string): number | undefined {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Takes the intake lock. The lock is created whole (never empty), so an empty lock is an unfinished or crashed writer.
 * A live pid refuses to start; a dead one is taken over.
 */
export function acquireLock(file: string): () => void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeNew(dir, name, `${process.pid}\n`, 0o600)) {
      return () => {
        if (readPid(file) === process.pid) fs.rmSync(file, { force: true });
      };
    }
    const stale = readPid(file);
    if (stale !== undefined && pidAlive(stale)) throw new CourierError('locked', 'another courier intake is running');
    const age = ageMs(file);
    if (stale === undefined && age !== undefined && age < LOCK_STALE_MS) {
      throw new CourierError('locked', 'another courier intake is running');
    }
    if (!takeOver(file, stale)) throw new CourierError('locked', 'another courier intake is running');
  }
  throw new CourierError('locked', 'could not take the intake lock');
}

/** Claims `guard` exclusively. A fresh guard held by another contender refuses; an abandoned one is replaced. */
function claimGuard(guard: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeNew(path.dirname(guard), path.basename(guard), `${process.pid}\n`, 0o600)) return true;
    const age = ageMs(guard);
    if (age !== undefined && age < LOCK_STALE_MS) return false;
    if (!retireStaleGuard(guard)) return false;
  }
  return false;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Retires an aged guard without unlinking a live one. The guard is first renamed to a private name, so only one
 * contender can move a given path. The moved file must still be the aged guard that was observed; if a fresh claim
 * slipped in between the check and the rename, it is linked back and the claim is refused.
 */
function retireStaleGuard(guard: string): boolean {
  const seen = readText(guard);
  const retired = `${guard}.${process.pid}.${randomBytes(6).toString('hex')}.retired`;
  try {
    fs.renameSync(guard, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const age = ageMs(retired);
  if (readText(retired) === seen && age !== undefined && age >= LOCK_STALE_MS) {
    fs.rmSync(retired, { force: true });
    return true;
  }
  try {
    fs.linkSync(retired, guard);
    fs.rmSync(retired, { force: true });
  } catch {
    // Another claim took the path meanwhile: keep the moved file rather than unlink a live guard.
  }
  return false;
}

/**
 * Removes a dead holder's lock. Takeovers are serialized by an exclusive guard file, and the pid is re-checked under
 * the guard before the lock is unlinked. A live lock is never renamed or unlinked: a changed pid refuses the takeover.
 */
function takeOver(file: string, stale: number | undefined): boolean {
  const guard = `${file}.takeover`;
  if (!claimGuard(guard)) return false;
  try {
    if (!fs.existsSync(file)) return true;
    if (readPid(file) !== stale) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    if (readPid(guard) === process.pid) fs.rmSync(guard, { force: true });
  }
}

/**
 * Per-peer intake progress. `receipts` holds the last few local receive times for the inbound rate cap.
 * `cursor` is the last mirror msgId examined; the next cycle resumes after it. Older builds also wrote `highWater`; the key is ignored.
 */
export interface PeerState {
  receipts: number[];
  cursor?: string;
}

export interface IntakeState {
  v: 1;
  peers: Record<string, PeerState>;
}

export function emptyState(): IntakeState {
  return { v: 1, peers: Object.create(null) as Record<string, PeerState> };
}

/** Reads the intake state. A missing file is an empty state; a corrupt one refuses to start, so nothing is re-queued. */
export function readState(file: string): IntakeState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CourierError('bad-state', 'intake state is not valid JSON');
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.peers)) throw new CourierError('bad-state', 'intake state has an unknown shape');
  for (const entry of Object.values(parsed.peers)) {
    if (!isRecord(entry) || !Array.isArray(entry.receipts) || (entry.cursor !== undefined && typeof entry.cursor !== 'string')) {
      throw new CourierError('bad-state', 'intake state has an unknown shape');
    }
  }
  const peers: Record<string, PeerState> = Object.create(null);
  for (const [peerId, entry] of Object.entries(parsed.peers)) peers[peerId] = entry as PeerState;
  return { v: 1, peers };
}

export function writeState(dir: string, file: string, state: IntakeState): void {
  writeReplace(dir, path.basename(file), `${JSON.stringify(state)}\n`, 0o600);
}
