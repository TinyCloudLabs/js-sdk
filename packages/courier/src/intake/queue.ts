import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CourierError } from '../errors.js';
import { isRecord } from '../a2a.js';

/** Creates a directory and refuses anything that is not a real directory (a symlink in its place is refused). */
export function ensureRealDir(dir: string, mode: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CourierError('unsafe-dir', 'queue or state path is not a real directory');
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
      const pid = readPid(file);
      if (pid !== undefined && pidAlive(pid)) throw new CourierError('locked', 'another courier intake is running');
      fs.rmSync(file, { force: true });
    }
  }
  throw new CourierError('locked', 'could not take the intake lock');
}

/** Per-peer intake progress. `highWater` is the newest message ULID already handled; `receipts` holds the last few local receive times for the inbound rate cap. */
export interface PeerState {
  highWater: string | null;
  receipts: number[];
}

export interface IntakeState {
  v: 1;
  peers: Record<string, PeerState>;
}

export function emptyState(): IntakeState {
  return { v: 1, peers: {} };
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
    if (!isRecord(entry) || !(entry.highWater === null || typeof entry.highWater === 'string') || !Array.isArray(entry.receipts)) {
      throw new CourierError('bad-state', 'intake state has an unknown shape');
    }
  }
  return parsed as unknown as IntakeState;
}

export function writeState(dir: string, file: string, state: IntakeState): void {
  writeReplace(dir, path.basename(file), `${JSON.stringify(state)}\n`, 0o600);
}
