import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CourierError } from '../errors.js';
import { isRecord } from '../a2a.js';

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

/** Makes a link or rename in `dir` durable: the directory entry is fsynced, not only the file contents. */
export function fsyncDir(dir: string): void {
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

interface LockRecord {
  pid: number;
  nonce: string;
}

type LockRead = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'held'; record: LockRecord };

/** Parses `{"pid":N,"nonce":"..."}`. A legacy `pid\n` lock parses with its own text as the nonce. */
function parseRecord(text: string): LockRecord | undefined {
  if (/^\d+\n?$/.test(text)) {
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? { pid, nonce: text } : undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { pid, nonce } = value as { pid?: unknown; nonce?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof nonce !== 'string' || nonce.length === 0) return undefined;
    return { pid, nonce };
  } catch {
    return undefined;
  }
}

function recordBody(record: LockRecord): string {
  return `${JSON.stringify({ pid: record.pid, nonce: record.nonce })}\n`;
}

function readRecordFile(file: string): LockRecord | undefined {
  try {
    return parseRecord(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Reads the lock. An unparseable lock is never broken: it refuses, as a live one would. */
function readLock(file: string): LockRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const record = parseRecord(text);
  return record ? { kind: 'held', record } : { kind: 'corrupt' };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockOptions {
  /** Pid recorded in this contender's lock. Default: this process. */
  pid?: number;
  /** Liveness probe for a recorded pid. Default: a signal-0 probe. */
  alive?: (pid: number) => boolean;
  /** Test seam: runs after a dead holder is observed, before any break guard is claimed. */
  afterObserve?: () => void;
}

/** Guard slots per dead lock. The bound stops a corrupt directory from looping forever. */
const MAX_BREAK_GUARDS = 8;

/**
 * Takes the intake lock. A live holder always refuses, however old its files are; only a holder whose pid is dead is
 * broken. The lock is created whole (never empty) and carries a nonce, so a release or a break removes only the lock
 * it actually observed.
 */
export function acquireLock(file: string, opts: LockOptions = {}): () => void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const alive = opts.alive ?? pidAlive;
  const self: LockRecord = { pid: opts.pid ?? process.pid, nonce: randomBytes(6).toString('hex') };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (writeNew(dir, name, recordBody(self), 0o600)) {
      return () => {
        const current = readLock(file);
        if (current.kind === 'held' && current.record.nonce === self.nonce) fs.rmSync(file, { force: true });
      };
    }
    const seen = readLock(file);
    if (seen.kind === 'missing') continue;
    if (seen.kind === 'corrupt' || alive(seen.record.pid)) {
      throw new CourierError('locked', 'another courier intake is running');
    }
    opts.afterObserve?.();
    if (!breakDead(file, seen.record, self, alive)) {
      throw new CourierError('locked', 'another courier intake is running');
    }
  }
  throw new CourierError('locked', 'another courier intake is running');
}

/**
 * Breaks the dead lock `stale`. Breakers serialize on numbered guard files `<lock>.break.<nonce>.<k>`: guard k is
 * claimed exclusively; a guard whose holder is alive refuses the break, and one whose holder is dead is passed over.
 * Under the guard the lock is re-read and unlinked only if it is still exactly `stale`. Returns false when a live
 * contender holds the break, and true when the caller should retry creating its own lock.
 */
function breakDead(file: string, stale: LockRecord, self: LockRecord, alive: (pid: number) => boolean): boolean {
  const dir = path.dirname(file);
  const tag = `${path.basename(file)}.break.${stale.nonce.trim().replace(/[^A-Za-z0-9_-]/g, '_')}.`;
  const body = recordBody(self);
  let claimed = false;
  for (let k = 1; k <= MAX_BREAK_GUARDS && !claimed; k++) {
    const candidate = `${tag}${k}`;
    if (writeNew(dir, candidate, body, 0o600)) {
      claimed = true;
      break;
    }
    const holder = readRecordFile(path.join(dir, candidate));
    if (holder && alive(holder.pid)) return false;
  }
  if (!claimed) return false;
  try {
    const now = readLock(file);
    if (now.kind === 'held' && now.record.nonce === stale.nonce) fs.rmSync(file, { force: true });
    return true;
  } finally {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(tag)) fs.rmSync(path.join(dir, entry), { force: true });
    }
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
