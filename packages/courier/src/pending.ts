import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirOwnerOnly, profileDir } from './profile.js';
import type { GrantPayload } from './grant.js';

/**
 * OpenKey consumes a short code on the first redeem (a second GET is a 404), so the redeemed delegation
 * is the only copy of the owner's approval. It is written here, before any node call, and deleted only
 * once the grant and profile are saved. The record holds the delegation OpenKey returned, which carries
 * the agent's public key only; the agent's private key stays in key.json.
 */
const FILE = 'pending-grant.json';

interface PendingRecord {
  /** sha256 of the lower-cased code: the record is never served for another code. */
  codeHash: string;
  /** The delegation's SIWE expiry; a later record is dead weight and is dropped. */
  expiresAt: string;
  savedAt: string;
  delegation: GrantPayload;
}

interface PendingFile {
  v: 1;
  records: PendingRecord[];
}

export function codeHash(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

function pendingPath(): string {
  return path.join(profileDir(), FILE);
}

function writeDurable(file: string, data: PendingFile): void {
  mkdirOwnerOnly(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

function isRecord(value: unknown): value is PendingRecord {
  const record = value as PendingRecord | null;
  return !!record && typeof record === 'object' && typeof record.codeHash === 'string'
    && typeof record.expiresAt === 'string' && !!record.delegation && typeof record.delegation === 'object';
}

/** Live records, newest last. Expired or unreadable state is removed; a loose mode is repaired; a non-regular path is left alone. */
function readRecords(): PendingRecord[] {
  const file = pendingPath();
  let records: PendingRecord[];
  let fd: number | undefined;
  try {
    // O_NOFOLLOW: a symlink is never followed; O_NONBLOCK: a FIFO cannot hang the open (fstat then refuses it). Everything after the open works on the descriptor, not the path.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) return [];
    // The only copy of a consumed code is repaired, not destroyed, over a loose mode; a failed repair still reads it.
    if ((stat.mode & 0o077) !== 0) { try { fs.fchmodSync(fd, 0o600); } catch { /* read it as it is */ } }
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as PendingFile;
    if (parsed.v !== 1 || !Array.isArray(parsed.records)) throw new Error('unknown format');
    records = parsed.records.filter(isRecord);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: nothing saved. ELOOP: a symlink stands there, not ours to touch.
    if (code !== 'ENOENT' && code !== 'ELOOP') fs.rmSync(file, { force: true });
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const live = records.filter((record) => Date.parse(record.expiresAt) > Date.now());
  if (live.length !== records.length) store(live);
  return live;
}

function store(records: PendingRecord[]): void {
  if (records.length === 0) fs.rmSync(pendingPath(), { force: true });
  else writeDurable(pendingPath(), { v: 1, records });
}

/** The delegations of the unexpired records. Read-only: unlike the readers around it, it never removes, repairs or rewrites anything. */
export function liveRedeemedDelegations(): GrantPayload[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as PendingFile;
    if (parsed.v !== 1 || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter(isRecord).filter((record) => Date.parse(record.expiresAt) > Date.now()).map((record) => record.delegation);
  } catch {
    return [];
  }
}

/** Whether an unexpired record exists (read-only, see `liveRedeemedDelegations`). */
export function hasLivePending(): boolean {
  return liveRedeemedDelegations().length > 0;
}

/** The unexpired record saved for this code, if any. */
export function pendingForCode(code: string): GrantPayload | undefined {
  const hash = codeHash(code);
  return readRecords().find((record) => record.codeHash === hash)?.delegation;
}

/** The most recently saved unexpired record, for `init --resume` (which has no code). */
export function newestPending(): GrantPayload | undefined {
  return readRecords().at(-1)?.delegation;
}

/** Save the redeemed delegation durably, replacing an earlier record for the same code. */
export function savePending(code: string, delegation: GrantPayload, expiresAt: Date): void {
  const hash = codeHash(code);
  const records = readRecords().filter((record) => record.codeHash !== hash);
  records.push({ codeHash: hash, expiresAt: expiresAt.toISOString(), savedAt: new Date().toISOString(), delegation });
  store(records);
}

/** Delete the record whose delegation was installed. Other codes' records are untouched. */
export function dropPendingDelegation(delegationCid: string): void {
  const records = readRecords();
  const kept = records.filter((record) => record.delegation.delegationCid !== delegationCid);
  if (kept.length !== records.length) store(kept);
}

/** Delete the record saved for this code (a refused record must not be served again). */
export function dropPendingForCode(code: string): void {
  const hash = codeHash(code);
  const records = readRecords();
  const kept = records.filter((record) => record.codeHash !== hash);
  if (kept.length !== records.length) store(kept);
}

/** Delete every record: used when `init --resume` finds the newest one bound to another key. */
export function dropAllPending(): void {
  fs.rmSync(pendingPath(), { force: true });
}
