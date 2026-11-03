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
 * `pid` and `nonce` are the ownership record. `machine` (machine-id) and `boot` (a true per-boot id) say which machine and boot it ran on;
 * `host` and `pidns` say where a pid number means anything.
 */
export interface LockRecord {
  pid: number;
  nonce: string;
  host?: string;
  pidns?: string;
  machine?: string;
  boot?: string;
}

const MAX_FIELD = 128;
const OPTIONAL_FIELDS = ['host', 'pidns', 'machine', 'boot'] as const;

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

/** Parses the JSON identity record used by Courier's temporary-file sidecars. Legacy pid-only locks are not sidecar records. */
export function parseIdentityRecord(text: string): LockRecord | undefined {
  if (!text.trimStart().startsWith('{')) return undefined;
  return parseRecord(text);
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
const UUID_BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trueBootIdentity(value: string | undefined): { kind: 'linux' | 'macos'; id: string } | undefined {
  const match = /^(linux|macos):(.+)$/.exec(value ?? '');
  if (!match || !UUID_BOOT_ID.test(match[2]!)) return undefined;
  return { kind: match[1]!.toLowerCase() as 'linux' | 'macos', id: match[2]!.toLowerCase() };
}

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
    if (id && UUID_BOOT_ID.test(id)) boot = `linux:${id}`;
  } else if (io.platform === 'darwin') {
    machine = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(io.exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']) ?? '')?.[1];
    const id = firstLine(io.exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']));
    if (id && UUID_BOOT_ID.test(id)) boot = `macos:${id}`;
  } else if (io.platform === 'win32') {
    const reg = `${io.systemRoot ?? 'C:\\Windows'}\\System32\\reg.exe`;
    machine = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(io.exec(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']) ?? '')?.[1];
  }
  return { ...(machine === undefined ? {} : { machine }), ...(boot === undefined ? {} : { boot }) };
}

let cachedIdentity: { machine?: string; boot?: string } | undefined;
const currentIdentity = (): { machine?: string; boot?: string } => (cachedIdentity ??= machineIdentity());

/** What this process records about itself: enough to tell another machine's, boot's or pid namespace's records apart. */
function identity(here: { machine?: string; boot?: string }): Pick<LockRecord, 'host' | 'pidns' | 'machine' | 'boot'> {
  const out: Pick<LockRecord, 'host' | 'pidns' | 'machine' | 'boot'> = { host: os.hostname(), ...here };
  const ns = pidNamespace();
  if (ns !== undefined) out.pidns = ns;
  return out;
}

/** The identity fields Courier records beside a temp file and in a lock. */
export function processIdentityRecord(pid: number, nonce: string, here: { machine?: string; boot?: string } = currentIdentity()): LockRecord {
  return { pid, nonce, ...identity(here) };
}

export type Liveness = 'alive' | 'dead' | 'unknown';

/**
 * Whether the process that wrote `record` still runs. A holder is `dead` in exactly two cases, and `unknown` (the lock is kept) in every other:
 *   (a) a different true boot id of the same kind on the same machine and host: no process survives a reboot; or
 *   (b) its pid is absent (`ESRCH`).
 * Before either, the record must name this machine (machine-id) and this host (another machine, a cloned machine-id, a renamed host, an old
 * pid-only record, or an identity this process cannot read is never judged), and on Linux the same pid namespace as this process: a reader in
 * another pid namespace sees a live holder's pid as absent. A pid that exists is never `dead`, whatever its start time, state or owner: a
 * crashed holder whose pid was reused needs the manual recovery line.
 */
export function recordLiveness(record: LockRecord, here: { machine?: string; boot?: string } = currentIdentity()): Liveness {
  if (record.machine === undefined || here.machine === undefined || record.machine !== here.machine) return 'unknown';
  if (record.host === undefined || record.host !== os.hostname()) return 'unknown';
  const recordBoot = trueBootIdentity(record.boot);
  const currentBoot = trueBootIdentity(here.boot);
  if (recordBoot && currentBoot && recordBoot.kind === currentBoot.kind && recordBoot.id !== currentBoot.id) return 'dead';
  const ns = pidNamespace();
  if (process.platform === 'linux' ? record.pidns === undefined || ns === undefined || record.pidns !== ns : record.pidns !== undefined && record.pidns !== ns) return 'unknown';
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  return 'unknown';
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
  /** Liveness probe for a recorded pid. Default: `recordLiveness` (dead only on a true boot-id change, or an absent pid; on Linux the pid must be looked up in the same pid namespace as the record's). */
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

/** A shell-safe cleanup command for a literal path, using POSIX shell or PowerShell quoting. */
export function formatRemovalCommand(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `Remove-Item -LiteralPath '${file.replace(/['\u2018-\u201B]/g, (quote) => quote + quote)}' -Force`
    : `rm -f -- '${file.replace(/'/g, `'\\''`)}'`;
}

/** The one line a refused lock prints: what holds it, and the only safe way out. The lock itself is never removed on doubt. */
export function lockRefusal({ file, reason, pid, host, record }: LockRefusal, platform: NodeJS.Platform = process.platform): string {
  // Text from a lock record is data, not words: JSON-quoted so a hostile host name cannot add lines or terminal escapes.
  const holder = pid === undefined ? 'a holder that cannot be read' : `pid ${pid}${host === undefined ? '' : ` on host ${JSON.stringify(host)}`}`;
  const why = reason === 'alive' ? `is held by a running Courier command (${holder})`
    : reason === 'corrupt' ? 'has a record Courier cannot read'
      : reason === 'unknown' ? `is held by ${holder}, and Courier cannot tell whether that process is still running`
        : `is held by ${holder}, and another Courier command is already working on clearing it`;
  const remove = formatRemovalCommand(file, platform);
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
  const self = processIdentityRecord(pid, randomBytes(6).toString('hex'), here);
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
