import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

function pidNamespace(): string | undefined {
  try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return undefined; }
}

/** How identity is read: injectable so every platform's branch is testable on one machine. */
export interface IdentityIo {
  platform: NodeJS.Platform;
  systemRoot?: string;
  readFile(file: string): string | undefined;
  exec(command: string, args: string[]): string | undefined;
}

const realIo: IdentityIo = {
  platform: process.platform,
  ...(process.env.SystemRoot === undefined ? {} : { systemRoot: process.env.SystemRoot }),
  readFile: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } },
  exec: (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { return undefined; } },
};

const firstLine = (text: string | undefined): string | undefined => text?.trim().split(/\r?\n/)[0]?.trim() || undefined;

/**
 * The machine and the boot this process runs on. `boot` is a true per-boot identifier or absent, and is prefixed with the platform that
 * produced it so two kinds are never compared. Linux: /etc/machine-id and the kernel boot id. macOS: IOPlatformUUID (`/usr/sbin/ioreg`) and
 * kern.bootsessionuuid (`/usr/sbin/sysctl`). Windows: MachineGuid (`%SystemRoot%\\System32\\reg.exe`); Windows has no per-boot identifier
 * verified to be stable, so it has none. Wall-clock values (`kern.boottime`, LastBootUpTime, uptime) are never used: they jitter and shift
 * with the clock, and a lock must not be called dead on a clock difference. An identity that cannot be read stays absent: records are then not judged.
 */
export function machineIdentity(io: IdentityIo = realIo): { machine?: string; boot?: string } {
  let machine: string | undefined;
  let boot: string | undefined;
  if (io.platform === 'linux') {
    machine = firstLine(io.readFile('/etc/machine-id')) ?? firstLine(io.readFile('/var/lib/dbus/machine-id'));
    const id = firstLine(io.readFile('/proc/sys/kernel/random/boot_id'));
    if (id) boot = `linux:${id}`;
  } else if (io.platform === 'darwin') {
    machine = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(io.exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']) ?? '')?.[1];
    const id = firstLine(io.exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']));
    if (id) boot = `macos:${id}`;
  } else if (io.platform === 'win32') {
    const reg = `${io.systemRoot ?? 'C:\\Windows'}\\System32\\reg.exe`;
    machine = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(io.exec(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']) ?? '')?.[1];
  }
  return { ...(machine === undefined ? {} : { machine }), ...(boot === undefined ? {} : { boot }) };
}

let cachedIdentity: { machine?: string; boot?: string } | undefined;
const currentIdentity = (): { machine?: string; boot?: string } => (cachedIdentity ??= machineIdentity());

/** What this process records about itself: enough to recognize it later, and to tell another machine's, boot's or pid namespace's records apart. */
function identity(pid: number, here: { machine?: string; boot?: string }): Pick<LockRecord, 'start' | 'host' | 'pidns' | 'machine' | 'boot'> {
  const out: Pick<LockRecord, 'start' | 'host' | 'pidns' | 'machine' | 'boot'> = { host: os.hostname(), ...here };
  const start = processStart(pid);
  if (start !== undefined) out.start = start;
  const ns = pidNamespace();
  if (ns !== undefined) out.pidns = ns;
  return out;
}

export type Liveness = 'alive' | 'dead' | 'unknown';

/**
 * Whether the process that wrote `record` still runs. Order: (1) the record must name this machine (machine-id) AND this host, else
 * `unknown`: another machine, a cloned machine-id, a renamed host, an old pid-only record, or an identity this process cannot read is
 * never judged. (2) Two true boot ids of the same kind that differ prove a reboot: `dead`. Wall-clock boot values never decide. (3) Otherwise
 * only positive evidence about the pid counts: gone (`ESRCH`), exited (a zombie, Linux), or a different process start time (Linux, where
 * /proc gives one). A pid namespace that differs is `unknown`. A live pid that cannot be told from a reused one (no start time to compare,
 * every platform but Linux) is `unknown`, never `dead`.
 */
export function recordLiveness(record: LockRecord, here: { machine?: string; boot?: string } = currentIdentity()): Liveness {
  if (record.machine === undefined || here.machine === undefined || record.machine !== here.machine) return 'unknown';
  if (record.host === undefined || record.host !== os.hostname()) return 'unknown';
  if (record.boot !== undefined && here.boot !== undefined) {
    const [kindA, kindB] = [record.boot.split(':', 1)[0], here.boot.split(':', 1)[0]];
    if ((kindA === 'linux' || kindA === 'macos') && kindA === kindB && record.boot !== here.boot) return 'dead';
  }
  if (record.pidns !== undefined && record.pidns !== pidNamespace()) return 'unknown';
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
    // EPERM: the process exists but belongs to someone else. Its start time still tells a reused pid from the holder.
  }
  const info = procInfo(record.pid);
  if (info?.state === 'Z' || info?.state === 'X') return 'dead'; // exited, only not yet reaped
  if (record.start === undefined || info?.start === undefined) return 'unknown';
  return info.start === record.start ? 'alive' : 'dead';
}

/** Why a lock was refused: shown by the caller as one line naming the file, the holder and the safe manual way out. */
export interface LockRefusal {
  file: string;
  /** `alive`: a running holder; `unknown`: its death cannot be established; `corrupt`: the record cannot be read; `contended`: another command is already breaking a dead lock. */
  reason: 'alive' | 'unknown' | 'corrupt' | 'contended';
  pid?: number;
  host?: string;
  /** The holder's record as last read, for the message. */
  record?: string;
}

export interface LockOptions {
  /** Pid recorded in this contender's lock. Default: this process. */
  pid?: number;
  /** Liveness probe for a recorded pid. Default: pid, start time, host and pid-namespace identity (`recordLiveness`). */
  alive?: (pid: number) => boolean;
  /** Test seam: runs after a dead holder is observed, before any break guard is claimed. */
  afterObserve?: () => void;
  /** This machine's identity. Default: `machineIdentity()`. */
  identity?: () => { machine?: string; boot?: string };
  /** The error message for a refusal. Default: `lockRefusal`, one line naming the lock, its holder and the safe manual command. */
  refusal?: (info: LockRefusal) => string;
}

/** Guard slots per dead lock. The bound stops a corrupt directory from looping forever. */
const MAX_BREAK_GUARDS = 8;

/** The one line a refused lock prints: what holds it, and the only safe way out. The lock itself is never removed on doubt. */
export function lockRefusal({ file, reason, pid, host, record }: LockRefusal, platform: NodeJS.Platform = process.platform): string {
  // Text from a lock record is data, not words: JSON-quoted so a hostile host name cannot add lines or terminal escapes.
  const holder = pid === undefined ? 'a holder that cannot be read' : `pid ${pid}${host === undefined ? '' : ` on host ${JSON.stringify(host)}`}`;
  const why = reason === 'alive' ? `is held by a running Courier command (${holder})`
    : reason === 'corrupt' ? 'has a record Courier cannot read'
      : reason === 'unknown' ? `is held by ${holder}, and Courier cannot tell whether that process is still running`
        : `is held by ${holder}, and another Courier command is already working on clearing it`;
  const remove = platform === 'win32'
    ? `Remove-Item -LiteralPath '${file.replace(/'/g, "''")}' -Force` // PowerShell: single quotes are literal, a quote is doubled
    : `rm -f -- '${file.replace(/'/g, `'\\''`)}'`;
  return `${file} ${why}${record === undefined ? '' : ` (record ${record})`}; the lock was left in place. Try again; only after confirming no Courier command is running anywhere that uses this lock, clear it with: ${remove}`;
}

/**
 * Takes the lock `file`. A live or unknowable holder always refuses, however old its file is; only a holder that is established dead
 * is broken. The lock is created whole (never empty) and carries a nonce, so a release or a break removes only the lock it actually observed.
 */
export function acquireLock(file: string, opts: LockOptions = {}): () => void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const pid = opts.pid ?? process.pid;
  const here = (opts.identity ?? currentIdentity)();
  const self: LockRecord = { pid, nonce: randomBytes(6).toString('hex'), ...identity(pid, here) };
  const state = (record: LockRecord): Liveness => (opts.alive ? (opts.alive(record.pid) ? 'alive' : 'dead') : recordLiveness(record, here));
  const refuse = (info: Omit<LockRefusal, 'file'>): never => {
    throw new CourierError('locked', (opts.refusal ?? lockRefusal)({ file, ...info }));
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
    const holder = { pid: seen.record.pid, record: JSON.stringify({ pid: seen.record.pid, nonce: seen.record.nonce, ...(seen.record.host === undefined ? {} : { host: seen.record.host }) }), ...(seen.record.host === undefined ? {} : { host: seen.record.host }) };
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
  const body = recordBody(self);
  /** Guards whose breaker was read and judged dead: removed only while they still hold exactly that record, never one claimed meanwhile. */
  const dead = new Map<string, string>();
  const clearDead = (): void => {
    for (const [guard, text] of dead) {
      try { if (fs.readFileSync(guard, 'utf8') === text) fs.rmSync(guard, { force: true }); } catch { /* already gone */ }
    }
  };
  let own: string | undefined;
  let retries = 0;
  for (let k = 1; k <= MAX_BREAK_GUARDS && own === undefined; k++) {
    const candidate = path.join(dir, `${tag}${k}`);
    if (writeNew(dir, `${tag}${k}`, body, 0o600)) {
      own = candidate;
      break;
    }
    let text: string;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch (error) {
      // The breaker that held this guard finished and removed it between our failed create and this read: take the slot again.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && retries++ < MAX_BREAK_GUARDS) { k -= 1; continue; }
      return false;
    }
    const holder = parseRecord(text);
    if (!holder || state(holder) !== 'dead') return false;
    dead.set(candidate, text);
  }
  if (own === undefined) {
    // Every slot holds a guard whose breaker is dead: clear exactly those, or the break could never run again. The lock itself is still removed only by exact nonce.
    clearDead();
    return true;
  }
  try {
    const now = readLock(file);
    if (now.kind === 'held' && now.record.nonce === stale.nonce) fs.rmSync(file, { force: true });
    return true;
  } finally {
    clearDead();
    try { if (fs.readFileSync(own, 'utf8') === body) fs.rmSync(own, { force: true }); } catch { /* already gone */ }
  }
}
