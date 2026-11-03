import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CourierError } from './errors.js';

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
export function writeTemp(dir: string, name: string, body: string, mode: number): string {
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

/**
 * `pid` and `nonce` are the ownership record. `start` (Linux process start ticks) says which process that pid was, so a reused pid is not
 * mistaken for the holder; `machine` (machine-id) and `boot` (boot id) say which machine and boot it ran on, `host` and `pidns` are
 * for people and for the pid namespace check.
 */
interface LockRecord {
  pid: number;
  nonce: string;
  start?: string;
  host?: string;
  pidns?: string;
  machine?: string;
  boot?: string;
}

const MAX_FIELD = 128;
const OPTIONAL_FIELDS = ['start', 'host', 'pidns', 'machine', 'boot'] as const;

type LockRead = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'held'; record: LockRecord };

/** Parses `{"pid":N,"nonce":"..."}` (plus the optional identity fields). A legacy `pid\n` lock parses with its own text as the nonce. */
function parseRecord(text: string): LockRecord | undefined {
  if (/^\d+\n?$/.test(text)) {
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? { pid, nonce: text } : undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const fields = value as Record<string, unknown>;
    const { pid, nonce } = fields;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_FIELD) return undefined;
    const record: LockRecord = { pid, nonce };
    for (const key of OPTIONAL_FIELDS) {
      const field = fields[key];
      if (field === undefined) continue;
      if (typeof field !== 'string' || field.length > MAX_FIELD) return undefined; // an oversized or mistyped field is a corrupt record
      record[key] = field;
    }
    return record;
  } catch {
    return undefined;
  }
}

function recordBody(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
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

/** State and start time (clock ticks since boot) of `pid` from Linux /proc, or undefined when it cannot be read. */
function procInfo(pid: number): { state: string; start: string | undefined } | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0] ?? '', start: fields[19] || undefined };
  } catch {
    return undefined;
  }
}

export function processStart(pid: number): string | undefined {
  return procInfo(pid)?.start;
}

function readLine(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8').trim() || undefined; } catch { return undefined; }
}

function pidNamespace(): string | undefined {
  try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return undefined; }
}

/** The machine (machine-id) and the boot (boot id) this process runs on. A pid means something only on the same machine, in the same boot. */
function machineIdentity(): { machine?: string; boot?: string } {
  const machine = readLine('/etc/machine-id') ?? readLine('/var/lib/dbus/machine-id');
  const boot = readLine('/proc/sys/kernel/random/boot_id');
  return { ...(machine === undefined ? {} : { machine }), ...(boot === undefined ? {} : { boot }) };
}

/** What this process records about itself: enough to recognize it later, and to tell another machine's, boot's or pid namespace's records apart. */
function identity(pid: number): Pick<LockRecord, 'start' | 'host' | 'pidns' | 'machine' | 'boot'> {
  const out: Pick<LockRecord, 'start' | 'host' | 'pidns' | 'machine' | 'boot'> = { host: os.hostname(), ...machineIdentity() };
  const start = processStart(pid);
  if (start !== undefined) out.start = start;
  const ns = pidNamespace();
  if (ns !== undefined) out.pidns = ns;
  return out;
}

export type Liveness = 'alive' | 'dead' | 'unknown';

/**
 * Whether the process that wrote `record` still runs. `dead` only when that is established on THIS machine: the pid is gone, has exited
 * (a zombie), or now belongs to a process that started at a different time. A record from another machine, another boot, another pid
 * namespace, or one without both a machine-id and a boot id (an old pid-only lock), is `unknown`: a shared home directory can hold a live
 * remote pid that looks dead here. A live pid whose start time cannot be compared is `unknown` too, and an unknown holder is never broken.
 */
export function recordLiveness(record: LockRecord): Liveness {
  const here = machineIdentity();
  if (record.machine === undefined || record.boot === undefined || record.machine !== here.machine || record.boot !== here.boot) return 'unknown';
  if (record.host !== undefined && record.host !== os.hostname()) return 'unknown';
  if (record.pidns !== undefined && record.pidns !== pidNamespace()) return 'unknown';
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
    // EPERM: the process exists but belongs to someone else. Its start time still tells a reused pid from the holder.
  }
  const info = procInfo(record.pid);
  if (info?.state === 'Z' || info?.state === 'X') return 'dead'; // exited, only not yet reaped
  if (record.start === undefined) return 'alive';
  if (info?.start === undefined) return 'unknown';
  return info.start === record.start ? 'alive' : 'dead';
}

/** Why a lock was refused: shown by the caller as one line naming the file, the holder and the safe manual way out. */
export interface LockRefusal {
  file: string;
  /** `alive`: a running holder; `unknown`: its death cannot be established; `corrupt`: the record cannot be read; `contended`: another command is already breaking a dead lock. */
  reason: 'alive' | 'unknown' | 'corrupt' | 'contended';
  pid?: number;
  host?: string;
}

export interface LockOptions {
  /** Pid recorded in this contender's lock. Default: this process. */
  pid?: number;
  /** Liveness probe for a recorded pid. Default: pid, start time, host and pid-namespace identity (`recordLiveness`). */
  alive?: (pid: number) => boolean;
  /** Test seam: runs after a dead holder is observed, before any break guard is claimed. */
  afterObserve?: () => void;
  /** The error message for a refusal. Default: the intake wording. */
  refusal?: (info: LockRefusal) => string;
}

/** Guard slots per dead lock. The bound stops a corrupt directory from looping forever. */
const MAX_BREAK_GUARDS = 8;

const INTAKE_REFUSAL = () => 'another courier intake is running';

/**
 * Takes the lock `file`. A live or unknowable holder always refuses, however old its file is; only a holder that is established dead
 * is broken. The lock is created whole (never empty) and carries a nonce, so a release or a break removes only the lock it actually observed.
 */
export function acquireLock(file: string, opts: LockOptions = {}): () => void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const pid = opts.pid ?? process.pid;
  const self: LockRecord = { pid, nonce: randomBytes(6).toString('hex'), ...identity(pid) };
  const state = (record: LockRecord): Liveness => (opts.alive ? (opts.alive(record.pid) ? 'alive' : 'dead') : recordLiveness(record));
  const refuse = (info: Omit<LockRefusal, 'file'>): never => {
    throw new CourierError('locked', (opts.refusal ?? INTAKE_REFUSAL)({ file, ...info }));
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let seen = readLock(file);
    if (seen.kind === 'missing') {
      // Only a missing lock costs a temp file and two fsyncs: a held one is judged from a read, so a waiter polling every 10 ms writes nothing.
      let created: boolean;
      try {
        created = writeNew(dir, name, recordBody(self), 0o600);
      } catch (error) {
        const now = readLock(file); // linked, then a later step (the directory fsync) failed: do not leave a live-looking lock nobody holds
        if (now.kind === 'held' && now.record.nonce === self.nonce) fs.rmSync(file, { force: true });
        throw error;
      }
      if (created) {
        return () => {
          const current = readLock(file);
          if (current.kind === 'held' && current.record.nonce === self.nonce) fs.rmSync(file, { force: true });
        };
      }
      seen = readLock(file);
      if (seen.kind === 'missing') continue;
    }
    if (seen.kind === 'corrupt') return refuse({ reason: 'corrupt' });
    if (seen.kind !== 'held') continue;
    const holder = { pid: seen.record.pid, ...(seen.record.host === undefined ? {} : { host: seen.record.host }) };
    const live = state(seen.record);
    if (live !== 'dead') return refuse({ reason: live, ...holder });
    opts.afterObserve?.();
    if (!breakDead(file, seen.record, self, state)) return refuse({ reason: 'contended', ...holder });
  }
  return refuse({ reason: 'contended' });
}

/**
 * Breaks the dead lock `stale`. Breakers serialize on numbered guard files `<lock>.break.<nonce>.<k>`: guard k is
 * claimed exclusively; a guard whose holder is not dead refuses the break, and one whose holder is dead is passed over.
 * Under the guard the lock is re-read and unlinked only if it is still exactly `stale`. Returns false when a live
 * contender holds the break, and true when the caller should retry creating its own lock.
 */
function breakDead(file: string, stale: LockRecord, self: LockRecord, state: (record: LockRecord) => Liveness): boolean {
  const dir = path.dirname(file);
  const tag = `${path.basename(file)}.break.${stale.nonce.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.`;
  const sweep = (): void => {
    for (const entry of fs.readdirSync(dir)) if (entry.startsWith(tag)) fs.rmSync(path.join(dir, entry), { force: true });
  };
  const body = recordBody(self);
  let claimed = false;
  for (let k = 1; k <= MAX_BREAK_GUARDS && !claimed; k++) {
    const candidate = `${tag}${k}`;
    if (writeNew(dir, candidate, body, 0o600)) {
      claimed = true;
      break;
    }
    const holder = readRecordFile(path.join(dir, candidate));
    if (!holder || state(holder) !== 'dead') return false;
  }
  if (!claimed) {
    // Every slot holds a guard whose breaker is dead: clear them, or the break could never run again. The lock itself is still removed only by exact nonce.
    sweep();
    return true;
  }
  try {
    const now = readLock(file);
    if (now.kind === 'held' && now.record.nonce === stale.nonce) fs.rmSync(file, { force: true });
    return true;
  } finally {
    sweep();
  }
}
