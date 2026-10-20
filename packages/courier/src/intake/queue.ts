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

/** Takes the intake lock. A lock whose pid is no longer alive is taken over; a live one refuses to start. */
export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return () => {
        if (readPid(file) === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = readPid(file);
      if (stale !== undefined && pidAlive(stale)) throw new CourierError('locked', 'another courier intake is running');
      if (!takeOver(file, stale)) throw new CourierError('locked', 'another courier intake is running');
    }
  }
  throw new CourierError('locked', 'could not take the intake lock');
}

/**
 * Removes a dead holder's lock without ever unlinking a live one. The lock is renamed to a private tombstone first, so
 * only the tombstone is unlinked, and only when it still holds the dead pid. A different pid means another contender
 * replaced the stale lock first: the tombstone is linked back and the takeover is refused.
 */
function takeOver(file: string, stale: number | undefined): boolean {
  const tomb = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tomb`;
  try {
    fs.renameSync(file, tomb);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (readPid(tomb) === stale) {
    fs.rmSync(tomb, { force: true });
    return true;
  }
  try {
    fs.linkSync(tomb, file);
    fs.rmSync(tomb, { force: true });
  } catch {
    // Another lock already occupies the path; the tombstone stays as evidence of the replaced holder.
  }
  return false;
}

/** Per-peer intake progress. `receipts` holds the last few local receive times for the inbound rate cap. Older builds also wrote `highWater`; the key is ignored. */
export interface PeerState {
  receipts: number[];
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
    if (!isRecord(entry) || !Array.isArray(entry.receipts)) {
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
