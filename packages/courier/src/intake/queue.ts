import fs from 'node:fs';
import path from 'node:path';
import { CourierError } from '../errors.js';
import { isRecord } from '../a2a.js';
import { fsyncDir, writeNew, writeTemp } from '../file-lock.js';

export { acquireLock, fsyncDir, writeNew, type LockOptions } from '../file-lock.js';

/**
 * Creates a directory and refuses anything that is not a real directory (a symlink in its place is refused). `mode`
 * applies only to a directory this call creates; an existing directory keeps its mode, so a provisioned root (for
 * example setgid 2750) is never rewritten. Returns true when this call created the directory.
 */
export function ensureRealDir(dir: string, mode: number): boolean {
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
  return !existed;
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

/** One admitted arrival: the mirror msgId and its local receive time. Identity is the msgId, so equal times stay distinct. */
export interface Receipt {
  id: string;
  at: number;
}

/**
 * Per-peer intake progress. `receipts` holds this peer's admitted arrivals for the inbound rate cap.
 * `cursor` is the last mirror msgId examined; the next cycle resumes after it. Older builds also wrote `highWater`; the key is ignored.
 */
export interface PeerState {
  receipts: Receipt[];
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
  const peers: Record<string, PeerState> = Object.create(null);
  for (const [peerId, entry] of Object.entries(parsed.peers)) {
    if (!isRecord(entry) || !Array.isArray(entry.receipts) || (entry.cursor !== undefined && typeof entry.cursor !== 'string')) {
      throw new CourierError('bad-state', 'intake state has an unknown shape');
    }
    const peer: PeerState = { receipts: entry.receipts.map(readReceipt) };
    if (typeof entry.cursor === 'string') peer.cursor = entry.cursor;
    peers[peerId] = peer;
  }
  return { v: 1, peers };
}

/** Older builds wrote bare receive times; they get positional ids so they still count against the cap. */
function readReceipt(raw: unknown, index: number): Receipt {
  if (typeof raw === 'number') return { id: `legacy-${index}`, at: raw };
  if (isRecord(raw) && typeof raw.id === 'string' && typeof raw.at === 'number') return { id: raw.id, at: raw.at };
  throw new CourierError('bad-state', 'intake state has an unknown shape');
}

export function writeState(dir: string, file: string, state: IntakeState): void {
  writeReplace(dir, path.basename(file), `${JSON.stringify(state)}\n`, 0o600);
}
