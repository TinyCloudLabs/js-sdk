/**
 * Credential store under `<home>/credentials/`.
 *
 * - Directory is created 0700 and re-checked on every read (real dir, owned by
 *   the current uid, no group/world bits). Files are written 0600 via O_EXCL
 *   temp + fsync + rename, and read only with O_NOFOLLOW after an lstat check
 *   (regular file, 0600, owned by current uid, same dev/ino on open).
 * - Pending email-proof files hold the request `verifier`. The verifier is a
 *   bearer secret for completing that one request: anyone who reads the file
 *   can complete it with the OTP. It is kept only until the request succeeds,
 *   fails terminally, or expires. It is never printed.
 * - Pending files are keyed by sha256(requestId); at most one live request per
 *   address is kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  createEmailCredentialRequirement,
  createStoredCredentialRecord,
  credentialMatchesRequirement,
  type CredentialRequirement,
  type StoredCredentialRecord,
  type VerifiedCredential,
} from '@tinycloud/sdk-core';
import { EMAIL_PROOF_CREDENTIAL_TYPE, EMAIL_PROOF_PROFILE, type EmailProofPending } from '@tinycloud/web-sdk/credentials';
import { CourierError } from './errors.js';
import { profileDir } from './profile.js';

/**
 * Credentials held by Courier, keyed by holder DID and requirement digest.
 * Same `find`/`store` contract as the receiver custody used by `tinycloud share receive`.
 */
export interface CredentialSource {
  find(input: {
    readonly requirement: CredentialRequirement;
    readonly requirementDigest: string;
    readonly holderDid: string;
    readonly now?: Date;
  }): Promise<StoredCredentialRecord | undefined>;
  store(input: {
    readonly verified: VerifiedCredential;
    readonly requirement: CredentialRequirement;
    readonly requirementDigest: string;
    readonly holderDid: string;
    readonly now?: Date;
  }): Promise<StoredCredentialRecord>;
}

const DIR_NAME = 'credentials';

function credentialsDir(home: string): string {
  return path.join(home, DIR_NAME);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function credentialFile(home: string, holderDid: string, requirementDigest: string): string {
  return path.join(credentialsDir(home), `credential-${sha256Hex(`${holderDid}\n${requirementDigest}`)}.json`);
}

/** Pending files are named by a hash of the request id, so mailbox addresses never appear in file names. */
const PENDING_FILE_PATTERN = /^pending-[0-9a-f]{64}\.json$/;

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

function assertOwnerOnly(st: fs.Stats, label: string, expectedMode: string): void {
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CourierError('credential-permissions', `${label} must be owner-only (mode ${expectedMode}); found mode ${mode.toString(8)}.`);
  }
  assertOwnedByCurrentUser(st, label);
}

function assertOwnedByCurrentUser(st: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new CourierError('credential-permissions', `${label} is not owned by the current user.`);
  }
}

/** Creates the store directory 0700 if absent. Refuses a symlink or a directory owned by another user. */
function ensureSecureDir(home: string): void {
  const dir = credentialsDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new CourierError('credential-permissions', `${dir} must be a real directory, not a symlink or file.`);
  assertOwnedByCurrentUser(st, dir);
  fs.chmodSync(dir, 0o700);
}

/** Returns false when the store directory does not exist. Re-checks symlink, owner, and mode on every call. */
function checkSecureDir(home: string): boolean {
  const dir = credentialsDir(home);
  const st = lstatOrUndefined(dir);
  if (!st) return false;
  if (!st.isDirectory()) throw new CourierError('credential-permissions', `${dir} must be a real directory, not a symlink or file.`);
  assertOwnerOnly(st, dir, '0700');
  return true;
}

/**
 * Atomic owner-only write: O_EXCL|O_NOFOLLOW temp file at 0600, fsync, then rename.
 * Refuses to replace a destination that is not a regular file.
 */
function writeOwnerOnly(home: string, file: string, obj: unknown): void {
  ensureSecureDir(home);
  const existing = lstatOrUndefined(file);
  if (existing && !existing.isFile()) {
    throw new CourierError('credential-permissions', `${path.basename(file)} exists and is not a regular file; refusing to replace it.`);
  }
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

/**
 * Reads an owner-only JSON file. Re-checks the directory and the file on every read,
 * refuses symlinks, and confirms the opened descriptor is the same inode that was checked.
 */
function readOwnerOnly<T>(home: string, file: string): T | undefined {
  if (!checkSecureDir(home)) return undefined;
  const label = path.basename(file);
  const before = lstatOrUndefined(file);
  if (!before) return undefined;
  if (!before.isFile()) throw new CourierError('credential-permissions', `${label} must be a regular file; symlinks are refused.`);
  assertOwnerOnly(before, label, '0600');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new CourierError('credential-permissions', `${label} changed while it was being opened.`);
    }
    assertOwnerOnly(opened, label, '0600');
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CourierError('credential-store-invalid', `Invalid credential store file ${label}.`);
  }
}

function removeFile(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Requirement for "a proved mailbox at `address`" under the witness email profile. */
export function emailCredentialRequirement(address: string): CredentialRequirement {
  return createEmailCredentialRequirement({
    email: address,
    profile: EMAIL_PROOF_PROFILE,
    credentialType: EMAIL_PROOF_CREDENTIAL_TYPE,
  });
}

type PendingEntry = { readonly file: string; readonly pending: EmailProofPending; readonly expired: boolean };

/**
 * Every pending file in the store. Throws on unsafe files (left in place) and on malformed
 * files (deleted). Expired files are deleted and returned with `expired: true`.
 */
function loadPendingEntries(home: string, now: Date): PendingEntry[] {
  if (!checkSecureDir(home)) return [];
  const dir = credentialsDir(home);
  const entries: PendingEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!PENDING_FILE_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    const pending = readOwnerOnly<EmailProofPending>(home, file);
    if (!pending) continue;
    if (
      pending.type !== 'TinyCloudEmailProofPending' ||
      pending.version !== 1 ||
      typeof pending.address !== 'string' ||
      typeof pending.requestId !== 'string' ||
      typeof pending.expiresAt !== 'string' ||
      Number.isNaN(Date.parse(pending.expiresAt)) ||
      pendingFile(home, pending.requestId) !== file
    ) {
      removeFile(file);
      throw new CourierError('credential-store-invalid', 'Pending verification file is invalid and was deleted.');
    }
    const expired = Date.parse(pending.expiresAt) <= now.getTime();
    if (expired) removeFile(file);
    entries.push({ file, pending, expired });
  }
  return entries;
}

/**
 * Stores the pending email proof under its request id. A new request replaces any earlier
 * pending request for the same address, so at most one is live per address.
 */
export function savePendingEmailProof(pending: EmailProofPending, home = profileDir()): void {
  for (const entry of loadPendingEntries(home, new Date())) {
    if (entry.pending.address === pending.address) removeFile(entry.file);
  }
  writeOwnerOnly(home, pendingFile(home, pending.requestId), pending);
}

/**
 * Load and consume the pending email proof for `address`. An expired pending file is deleted
 * and reported as expired. The caller deletes the file again on any terminal failure.
 */
export function takePendingEmailProof(address: string, now: Date = new Date(), home = profileDir()): EmailProofPending {
  const matches = loadPendingEntries(home, now).filter((entry) => entry.pending.address === address);
  if (matches.length === 0) {
    throw new CourierError('credential-request-missing', `No pending verification for ${address}. Run \`courier credential acquire --email ${address}\` first.`);
  }
  if (matches.length > 1) {
    for (const entry of matches) removeFile(entry.file);
    throw new CourierError('credential-store-invalid', 'Multiple pending verifications existed for one address and were deleted. Run acquire again.');
  }
  const [entry] = matches;
  if (entry.expired) {
    throw new CourierError('credential-session-expired', `Verification for ${address} expired. Run \`courier credential acquire --email ${address}\` again.`);
  }
  return entry.pending;
}

/** Deletes the pending file for one request id. */
export function removePendingEmailProof(requestId: string, home = profileDir()): void {
  removeFile(pendingFile(home, requestId));
}

/** Stored credentials for the Courier agent. Records are dropped once they fail the requirement's window. */
export class StoredCredentialSource implements CredentialSource {
  constructor(private readonly home: string = profileDir()) {}

  async find(input: { readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly now?: Date }): Promise<StoredCredentialRecord | undefined> {
    const file = credentialFile(this.home, input.holderDid, input.requirementDigest);
    const record = readOwnerOnly<StoredCredentialRecord>(this.home, file);
    if (!record) return undefined;
    const now = input.now ?? new Date();
    if (!credentialMatchesRequirement(input.requirement, record, input.holderDid, now)) {
      removeFile(file);
      return undefined;
    }
    return record;
  }

  async store(input: { readonly verified: VerifiedCredential; readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly now?: Date }): Promise<StoredCredentialRecord> {
    const record = await createStoredCredentialRecord({
      verified: input.verified,
      ownerDid: input.holderDid,
      requirement: input.requirement,
      requirementDigest: input.requirementDigest,
      storedAt: (input.now ?? new Date()).toISOString(),
    });
    writeOwnerOnly(this.home, credentialFile(this.home, input.holderDid, input.requirementDigest), record);
    return record;
  }
}
