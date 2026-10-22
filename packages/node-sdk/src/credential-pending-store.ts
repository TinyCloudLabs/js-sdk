import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * File-backed pending store for the email-proof flow (`@tinycloud/web-sdk/credentials`).
 *
 * A pending record holds a bearer verifier, so the store is owner-only: a 0700 directory,
 * 0600 files, and symlink, hard-link, and owner checks on every read. Records expire on
 * read and are capped at 15 minutes from creation.
 *
 * Structural: the store needs only `requestId`, `address`, and `expiresAt` from a record.
 * The core's `EmailProofPendingStore` is satisfied without importing web-sdk, which depends on this package.
 */

/** Longest a pending record may live, measured from the moment it is written. */
export const EMAIL_PROOF_PENDING_MAX_MS = 15 * 60 * 1000;

export interface PendingRecord {
  readonly requestId: string;
  readonly address: string;
  readonly expiresAt: string;
}

export interface PendingStore<P extends PendingRecord> {
  load(address: string, now: Date): Promise<P | undefined>;
  save(pending: P): Promise<void>;
  delete(pending: P): Promise<void>;
}

export type PendingStoreErrorCode = 'credential-permissions' | 'credential-store-invalid';

export class PendingStoreError extends Error {
  readonly code: PendingStoreErrorCode;

  constructor(code: PendingStoreErrorCode, message: string) {
    super(message);
    this.name = 'PendingStoreError';
    this.code = code;
  }
}

export interface FileEmailProofPendingStoreOptions {
  /** Profile directory. Pending files live under `<home>/credentials`. Must be an absolute path. */
  readonly home: string;
}

const DIR_NAME = 'credentials';
/** Pending files are named by a hash of the request id, so mailbox addresses never appear in file names. */
const PENDING_FILE_PATTERN = /^pending-[0-9a-f]{64}\.json$/;
/** Temp files from `writeOwnerOnly`: `<pending file>.<pid>.<12 hex>.tmp`. */
const PENDING_TEMP_PATTERN = /^pending-[0-9a-f]{64}\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function credentialsDir(home: string): string {
  return path.join(home, DIR_NAME);
}

function pendingFile(home: string, requestId: string): string {
  return path.join(credentialsDir(home), `pending-${sha256Hex(requestId)}.json`);
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertOwnedByCurrentUser(st: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new PendingStoreError('credential-permissions', `${label} is not owned by the current user.`);
  }
}

function assertOwnerOnly(st: fs.Stats, label: string): void {
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new PendingStoreError('credential-permissions', `${label} must be owner-only; found mode ${mode.toString(8)}.`);
  }
  assertOwnedByCurrentUser(st, label);
}

/** Refuses a symlinked profile directory. A missing one is fine: the caller creates it. */
function assertHomeNotSymlink(home: string): void {
  const st = lstatOrUndefined(home);
  if (st?.isSymbolicLink()) {
    throw new PendingStoreError('credential-permissions', `${home} is a symlink; refusing to store credentials through it.`);
  }
}

/** Creates the store directory 0700 if absent, then pins its mode (umask may have narrowed the create). */
function ensureSecureDir(home: string): void {
  assertHomeNotSymlink(home);
  const dir = credentialsDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) {
    throw new PendingStoreError('credential-permissions', `${dir} must be a real directory, not a symlink or file.`);
  }
  assertOwnedByCurrentUser(st, dir);
  fs.chmodSync(dir, 0o700);
}

/** Returns false when the store directory does not exist. Re-checks symlink, owner, and mode on every call. */
function checkSecureDir(home: string): boolean {
  assertHomeNotSymlink(home);
  const dir = credentialsDir(home);
  const st = lstatOrUndefined(dir);
  if (!st) return false;
  if (!st.isDirectory()) {
    throw new PendingStoreError('credential-permissions', `${dir} must be a real directory, not a symlink or file.`);
  }
  assertOwnerOnly(st, dir);
  return true;
}

/**
 * Atomic owner-only write: O_EXCL|O_NOFOLLOW temp file at 0600, fsync, then rename.
 * Refuses to replace a destination that is not a regular file.
 */
function writeOwnerOnly(home: string, file: string, record: unknown): void {
  ensureSecureDir(home);
  const existing = lstatOrUndefined(file);
  if (existing && !existing.isFile()) {
    throw new PendingStoreError('credential-permissions', `${path.basename(file)} exists and is not a regular file; refusing to replace it.`);
  }
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      /* renamed or absent */
    }
  }
}

/**
 * Reads an owner-only JSON file. Re-checks the directory and the file on every read, refuses
 * symlinks and hard links, and confirms the opened descriptor is the inode that was checked.
 */
function readOwnerOnly(home: string, file: string): unknown {
  if (!checkSecureDir(home)) return undefined;
  const label = path.basename(file);
  const before = lstatOrUndefined(file);
  if (!before) return undefined;
  if (!before.isFile()) {
    throw new PendingStoreError('credential-permissions', `${label} must be a regular file; symlinks are refused.`);
  }
  assertOwnerOnly(before, label);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new PendingStoreError('credential-permissions', `${label} changed while it was being opened.`);
    }
    if (opened.nlink !== 1) {
      throw new PendingStoreError('credential-permissions', `${label} has multiple hard links; refusing to read it.`);
    }
    assertOwnerOnly(opened, label);
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PendingStoreError('credential-store-invalid', `Invalid credential store file ${label}.`);
  }
}

function removeFile(file: string): void {
  fs.rmSync(file, { force: true });
}

/** A temp file older than the pending window was left by a killed writer. It may hold a verifier, so it is deleted. */
function sweepAbandonedTemp(file: string, now: Date): void {
  const st = lstatOrUndefined(file);
  if (st && now.getTime() - st.mtimeMs > EMAIL_PROOF_PENDING_MAX_MS) removeFile(file);
}

function assertWithinWindow(record: PendingRecord, now: Date): void {
  if (Date.parse(record.expiresAt) > now.getTime() + EMAIL_PROOF_PENDING_MAX_MS) {
    throw new PendingStoreError('credential-store-invalid', 'Pending record expires beyond the 15-minute window and was rejected.');
  }
}

function isPendingRecord(value: unknown): value is PendingRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.requestId === 'string'
    && typeof record.address === 'string'
    && typeof record.expiresAt === 'string'
    && !Number.isNaN(Date.parse(record.expiresAt));
}

interface Entry<P extends PendingRecord> {
  readonly file: string;
  readonly record: P;
  readonly expired: boolean;
}

/**
 * Every pending file in the store. Throws on unsafe files (left in place) and on malformed
 * files (deleted). Expired files are deleted and returned with `expired: true`.
 */
function loadEntries<P extends PendingRecord>(home: string, now: Date): Entry<P>[] {
  if (!checkSecureDir(home)) return [];
  const dir = credentialsDir(home);
  const entries: Entry<P>[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (PENDING_TEMP_PATTERN.test(name)) {
      sweepAbandonedTemp(file, now);
      continue;
    }
    if (!PENDING_FILE_PATTERN.test(name)) continue;
    const value = readOwnerOnly(home, file);
    if (value === undefined) continue;
    if (!isPendingRecord(value) || pendingFile(home, value.requestId) !== file || Date.parse(value.expiresAt) > now.getTime() + EMAIL_PROOF_PENDING_MAX_MS) {
      removeFile(file);
      throw new PendingStoreError('credential-store-invalid', 'Pending verification file is invalid and was deleted.');
    }
    const expired = Date.parse(value.expiresAt) <= now.getTime();
    if (expired) removeFile(file);
    entries.push({ file, record: value as P, expired });
  }
  return entries;
}

/**
 * File-backed `PendingStore`. At most one live record per address: `save` replaces an earlier
 * one, and `load` treats two live records for one address as corruption and deletes both.
 */
export function createFileEmailProofPendingStore<P extends PendingRecord>(options: FileEmailProofPendingStoreOptions): PendingStore<P> {
  const { home } = options;
  return {
    async load(address, now) {
      const live = loadEntries<P>(home, now).filter((entry) => !entry.expired && entry.record.address === address);
      if (live.length === 0) return undefined;
      if (live.length > 1) {
        for (const entry of live) removeFile(entry.file);
        throw new PendingStoreError('credential-store-invalid', 'Multiple pending verifications existed for one address and were deleted. Request a new code.');
      }
      return live[0]!.record;
    },
    async save(pending) {
      const now = new Date();
      assertWithinWindow(pending, now);
      for (const entry of loadEntries<P>(home, now)) {
        if (entry.record.address === pending.address) removeFile(entry.file);
      }
      writeOwnerOnly(home, pendingFile(home, pending.requestId), pending);
    },
    async delete(pending) {
      if (!checkSecureDir(home)) return;
      removeFile(pendingFile(home, pending.requestId));
    },
  };
}
