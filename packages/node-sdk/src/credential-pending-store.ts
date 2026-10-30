import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EMAIL_PROOF_PENDING_MAX_MS,
  pendingDeadlineMs,
  restoreEmailProofPending,
  type EmailProofPending,
  type EmailProofPendingStore,
} from './credentials/email-proof';

/**
 * File-backed pending store for the email-proof flow (`@tinycloud/node-sdk/credential-pending-store`).
 *
 * One file per request, named `pending-<sha256(requestId)>.json`. No file name contains a mailbox
 * address. A record holds a bearer verifier and optionally a base64 secret, so the store is owner-only:
 * a 0700 directory, 0600 files, and symlink, hard-link, and owner checks on every read. A record may
 * not expire more than 15 minutes after its `createdAt`; records expire on read.
 * Only a symlinked final `home` is refused. Ancestors may be symlinks; the resolved `home` must be owned by the current user.
 *
 * Unsafe files throw and are left in place. Malformed or over-long files are deleted and throw.
 * One unsafe file therefore makes `findLive` throw for every address until the file is removed.
 */

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
  /** Absolute profile directory. Pending files live under `<home>/credentials`. */
  readonly home: string;
}

export interface PutEmailProofPendingOptions {
  /** Optional caller secret, stored base64 in the owner-only file. Read it back with `storedSecret`. Never serialized. */
  readonly secret?: Uint8Array;
}

export interface FileEmailProofPendingStore extends EmailProofPendingStore {
  get(requestId: string, now: Date): Promise<EmailProofPending | undefined>;
  put(pending: EmailProofPending, options?: PutEmailProofPendingOptions): Promise<void>;
}

/** The secret stored with a pending record, or undefined. Returns a copy; the record keeps its own. */
export function storedSecret(pending: EmailProofPending): Uint8Array | undefined {
  const secret = secrets.get(pending);
  return secret === undefined ? undefined : new Uint8Array(secret);
}

const DIR_NAME = 'credentials';
const PENDING_FILE_PATTERN = /^pending-[0-9a-f]{64}\.json$/;
/** Temp files from `writeOwnerOnly`: `<pending file>.<pid>.<12 hex>.tmp`. */
const PENDING_TEMP_PATTERN = /^pending-[0-9a-f]{64}\.json\.\d+\.[0-9a-f]{12}\.tmp$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FILE_TEXT_FIELDS = [
  'profile',
  'address',
  'requestId',
  'verifier',
  'holderDid',
  'descriptorDigest',
  'requirementDigest',
  'openerOrigin',
  'createdAt',
  'expiresAt',
] as const;

const HELD_PROFILE_ID = 'tinycloud.email-held/v1';

interface FileRecord {
  readonly type: 'TinyCloudEmailProofPending';
  readonly version: 1;
  readonly profile: string;
  readonly address: string;
  readonly requestId: string;
  readonly verifier: string;
  readonly holderDid: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly openerOrigin: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Held profile only (`tinycloud.email-held/v1`): `expiresAt` of the create response. Required for a held record, absent from every other. */
  readonly serverExpiresAt?: string;
  readonly secret?: string;
}

interface Entry {
  readonly pending: EmailProofPending;
  readonly expired: boolean;
}

const secrets = new WeakMap<EmailProofPending, Uint8Array>();

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function credentialsDir(home: string): string {
  return path.join(home, DIR_NAME);
}

function pendingFile(home: string, requestId: string): string {
  return path.join(credentialsDir(home), `pending-${sha256Hex(requestId)}.json`);
}

function assertAbsoluteHome(home: unknown): asserts home is string {
  if (typeof home !== 'string' || home.length === 0 || !path.isAbsolute(home)) {
    throw new PendingStoreError('credential-store-invalid', 'Credential store home must be a non-empty absolute path.');
  }
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
  // Owner check: a file owned by another user is untrusted even at mode 0600.
  assertOwnedByCurrentUser(st, label);
}

/**
 * Refuses a symlinked `home`. Ancestors may be symlinks (macOS `/var` is `/private/var`), so the resolved
 * `home` must be owned by the current user instead. A missing `home` is fine: the caller creates it.
 */
function assertHomeSafe(home: string): void {
  const st = lstatOrUndefined(home);
  if (st?.isSymbolicLink()) {
    throw new PendingStoreError('credential-permissions', `${home} is a symlink; refusing to store credentials through it.`);
  }
  if (st) assertOwnedByCurrentUser(fs.statSync(fs.realpathSync(home)), home);
}

/**
 * Creates each missing directory on `target` with mode 0700 and pins it, so a restrictive umask cannot
 * leave the store unwritable. Existing directories are not touched.
 */
function mkdirOwnerOnly(target: string): void {
  const missing: string[] = [];
  let current = target;
  while (lstatOrUndefined(current) === undefined) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of missing) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      // A pre-existing directory is not ours to chmod; ensureSecureDir checks it instead.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      continue;
    }
    fs.chmodSync(dir, 0o700);
  }
}

/** Creates the store directory 0700 if absent. A pre-existing directory must already be owner-only; it is never chmodded. */
export function ensureSecureDir(home: string): void {
  assertHomeSafe(home);
  const dir = credentialsDir(home);
  mkdirOwnerOnly(home);
  mkdirOwnerOnly(dir);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) {
    throw new PendingStoreError('credential-permissions', `${dir} must be a real directory, not a symlink or file.`);
  }
  // A loose pre-existing directory is refused, never chmodded: it may not be ours. assertOwnerOnly also checks the owner.
  assertOwnerOnly(st, dir);
}

/** Returns false when the store directory does not exist. Re-checks symlink, owner, and mode on every call. */
export function checkSecureDir(home: string): boolean {
  assertHomeSafe(home);
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
function writeOwnerOnly(home: string, file: string, record: FileRecord): void {
  ensureSecureDir(home);
  const existing = lstatOrUndefined(file);
  if (existing && !existing.isFile()) {
    throw new PendingStoreError('credential-permissions', `${path.basename(file)} exists and is not a regular file; refusing to replace it.`);
  }
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  // O_EXCL: never reuse an existing temp name. O_NOFOLLOW: a symlink planted at the temp name fails the open.
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
  // lstat and owner check run before the open; the fstat below compares the opened inode.
  assertOwnerOnly(before, label);
  // O_NOFOLLOW: a symlink swapped in after the lstat fails the open instead of being read.
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
    removeFile(file);
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

function exceedsWindow(record: { readonly createdAt: string; readonly expiresAt: string }): boolean {
  return Date.parse(record.expiresAt) > Date.parse(record.createdAt) + EMAIL_PROOF_PENDING_MAX_MS;
}

function isFileRecord(value: unknown): value is FileRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'TinyCloudEmailProofPending' || record.version !== 1) return false;
  if (!FILE_TEXT_FIELDS.every((field) => typeof record[field] === 'string')) return false;
  if (record.secret !== undefined && (typeof record.secret !== 'string' || !BASE64.test(record.secret))) return false;
  // serverExpiresAt: present and parseable for the held profile, absent for every other profile. Neither shape loads as the other.
  if (record.profile === HELD_PROFILE_ID) {
    if (typeof record.serverExpiresAt !== 'string' || !Number.isFinite(Date.parse(record.serverExpiresAt))) return false;
  } else if (record.serverExpiresAt !== undefined) {
    return false;
  }
  return Number.isFinite(Date.parse(record.createdAt as string)) && Number.isFinite(Date.parse(record.expiresAt as string));
}

/** Builds the pending object from named fields only. Unknown keys in the file (including `__proto__`) are ignored. */
function restoreFromFile(record: FileRecord): EmailProofPending {
  return restoreEmailProofPending({
    type: record.type,
    version: record.version,
    profile: record.profile as EmailProofPending['profile'],
    address: record.address,
    requestId: record.requestId,
    verifier: record.verifier,
    holderDid: record.holderDid,
    descriptorDigest: record.descriptorDigest,
    requirementDigest: record.requirementDigest,
    openerOrigin: record.openerOrigin,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.serverExpiresAt === undefined ? {} : { serverExpiresAt: record.serverExpiresAt }),
  });
}

/** Reads one pending file. Deletes expired files, and malformed or over-long files before throwing. */
function readEntry(home: string, file: string, now: Date): Entry | undefined {
  const value = readOwnerOnly(home, file);
  if (value === undefined) return undefined;
  if (!isFileRecord(value) || pendingFile(home, value.requestId) !== file || exceedsWindow(value)) {
    removeFile(file);
    throw new PendingStoreError('credential-store-invalid', 'Pending verification file is invalid and was deleted.');
  }
  const pending = restoreFromFile(value);
  if (value.secret !== undefined) secrets.set(pending, Buffer.from(value.secret, 'base64'));
  const expired = pendingDeadlineMs(pending) <= now.getTime();
  if (expired) removeFile(file);
  return { pending, expired };
}

function liveEntries(home: string, now: Date): Entry[] {
  if (!checkSecureDir(home)) return [];
  const dir = credentialsDir(home);
  const entries: Entry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (PENDING_TEMP_PATTERN.test(name)) {
      sweepAbandonedTemp(file, now);
      continue;
    }
    if (!PENDING_FILE_PATTERN.test(name)) continue;
    const entry = readEntry(home, file, now);
    if (entry) entries.push(entry);
  }
  return entries;
}

function toFileRecord(pending: EmailProofPending, secret: Uint8Array | undefined): FileRecord {
  return {
    type: pending.type,
    version: pending.version,
    profile: pending.profile,
    address: pending.address,
    requestId: pending.requestId,
    verifier: pending.verifier,
    holderDid: pending.holderDid,
    descriptorDigest: pending.descriptorDigest,
    requirementDigest: pending.requirementDigest,
    openerOrigin: pending.openerOrigin,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    ...(pending.serverExpiresAt === undefined ? {} : { serverExpiresAt: pending.serverExpiresAt }),
    ...(secret === undefined ? {} : { secret: Buffer.from(secret).toString('base64') }),
  };
}

/** Converts raw permission failures (for example EACCES under a restrictive umask) into a stable store error. */
function wrapFsErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PendingStoreError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new PendingStoreError('credential-permissions', 'Credential store is not accessible to this process; check the profile directory permissions.');
    }
    throw error;
  }
}

/**
 * File-backed `EmailProofPendingStore`, keyed by request id: one file per request, named by a hash of the
 * id. `put` never touches another request's file. `findLive` returns the newest unexpired record for an
 * address, so a second process can complete a request it did not create.
 */
export function createFileEmailProofPendingStore(options: FileEmailProofPendingStoreOptions): FileEmailProofPendingStore {
  const home: unknown = options?.home;
  assertAbsoluteHome(home);
  return {
    async get(requestId, now) {
      return wrapFsErrors(() => {
        const entry = readEntry(home, pendingFile(home, requestId), now);
        return entry === undefined || entry.expired ? undefined : entry.pending;
      });
    },
    async put(pending, putOptions) {
      return wrapFsErrors(() => {
        if (exceedsWindow(pending)) {
          throw new PendingStoreError('credential-store-invalid', 'Pending record expires beyond the 15-minute window and was rejected.');
        }
        const record = toFileRecord(pending, putOptions?.secret);
        if (!isFileRecord(record)) {
          throw new PendingStoreError('credential-store-invalid', 'Pending record is not a valid held or ticket record and was rejected.');
        }
        writeOwnerOnly(home, pendingFile(home, pending.requestId), record);
      });
    },
    async delete(requestId) {
      return wrapFsErrors(() => {
        if (!checkSecureDir(home)) return;
        removeFile(pendingFile(home, requestId));
      });
    },
    async findLive(address, now) {
      return wrapFsErrors(() => {
        let newest: EmailProofPending | undefined;
        for (const entry of liveEntries(home, now)) {
          if (entry.expired || entry.pending.address !== address) continue;
          if (!newest || Date.parse(entry.pending.createdAt) > Date.parse(newest.createdAt)) newest = entry.pending;
        }
        return newest;
      });
    },
  };
}
