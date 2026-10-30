/**
 * Credential store under `<home>/credentials/`.
 *
 * - Directory: `ensureSecureDir` / `checkSecureDir` from `@tinycloud/node-sdk/credential-pending-store`
 *   (real directory, owner-only, owned by the current uid; a symlink is refused and never chmodded).
 * - Files: written 0600 via O_EXCL temp + fsync + rename, and read only with O_NOFOLLOW after an
 *   lstat check (regular file, 0600, owned by current uid, same dev/ino on open). These file-level
 *   helpers are Courier-local; the pending store has its own record format.
 * - Every `find` and `store` re-verifies the envelope offline with `verifyStoredEmailProof`.
 *
 * Pending email-proof requests are not stored here; `@tinycloud/node-sdk/credential-pending-store`
 * owns them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { checkSecureDir, ensureSecureDir } from '@tinycloud/node-sdk/credential-pending-store';
import {
  isTicketEmailProofResult,
  verifyStoredEmailProof,
  type EmailProofResult,
  type StoredEmailProofRecord,
} from '@tinycloud/node-sdk/credentials';
import {
  createStoredCredentialRecord,
  EMAIL_CREDENTIAL_MAX_AGE_SECONDS,
  type CredentialRequirement,
} from '@tinycloud/sdk-core';
import { CourierError } from './errors.js';
import { profileDir } from './profile.js';

const DIR_NAME = 'credentials';

/**
 * A stored credential is returned only while more than this much of its own `exp` window remains.
 * A credential that expires within the margin is treated as expired, so a holder never starts a
 * use that a verifier with a slightly different clock would reject.
 */
const EXPIRY_MARGIN_MS = 60_000;

function credentialsDir(home: string): string {
  return path.join(home, DIR_NAME);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function credentialFile(home: string, holderDid: string, requirementDigest: string): string {
  return path.join(credentialsDir(home), `credential-${sha256Hex(`${holderDid}\n${requirementDigest}`)}.json`);
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
    if (opened.nlink !== 1) throw new CourierError('credential-permissions', `${label} has multiple hard links; refusing to read it.`);
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

/** The offline re-verify used by `StoredCredentialSource`. Injectable so tests can stand in for the issuer keys. */
export type StoredVerifier = typeof verifyStoredEmailProof;

/**
 * Stored email credentials for the Courier agent.
 *
 * - `find` authenticates the stored record first, with the offline verifier, and refuses anything that
 *   fails: the record is neither returned nor deleted, and the caller gets `credential-record-invalid`.
 * - Only then does the lifecycle apply, and only to the authenticated `issuedAt` and `expiresAt` (the
 *   verifier proves both equal the signed `iat` and `exp`): a credential with less than 60 s of its own
 *   `exp` left, or issued more than the maximum age ago, is deleted and reported as absent.
 *   Nothing is deleted on the strength of a stored field the verifier has not accepted.
 */
export class StoredCredentialSource {
  constructor(
    private readonly home: string = profileDir(),
    private readonly verify: typeof verifyStoredEmailProof = verifyStoredEmailProof,
  ) {}

  async find(input: { readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly now?: Date }): Promise<StoredEmailProofRecord | undefined> {
    const file = credentialFile(this.home, input.holderDid, input.requirementDigest);
    const record = readOwnerOnly<StoredEmailProofRecord>(this.home, file);
    if (!record) return undefined;
    const now = input.now ?? new Date();
    // The verifier enforces the validity window against the instant it is given. Authenticating at the
    // record's own issuance instant proves the signature and every stored field regardless of the clock,
    // so an honestly expired record is classified below from authenticated fields instead of being refused.
    // A stored issuedAt or expiresAt that differs from the signed iat or exp is refused by the verifier.
    const authenticatedAt = Math.max(Date.parse(record.issuedAt), Date.parse(record.notBefore));
    try {
      // The lifecycle below does arithmetic on these fields, so a verifier that accepted the record must not let a
      // field that is not a date through: NaN comparisons are all false and would keep an expired record.
      if (!Number.isFinite(authenticatedAt) || !Number.isFinite(Date.parse(record.expiresAt))) throw new Error('stored record has no usable dates');
      await this.verify({ record, requirement: input.requirement, holderDid: input.holderDid, now: new Date(authenticatedAt) });
    } catch {
      throw new CourierError('credential-record-invalid', 'Stored credential failed offline verification and was not returned. Run `credential acquire` again.');
    }
    const expired = Date.parse(record.expiresAt) - EXPIRY_MARGIN_MS <= now.getTime();
    const stale = now.getTime() - Date.parse(record.issuedAt) > EMAIL_CREDENTIAL_MAX_AGE_SECONDS * 1000;
    if (expired || stale) {
      removeFile(file);
      return undefined;
    }
    return record;
  }

  async store(input: { readonly result: EmailProofResult; readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly now?: Date }): Promise<StoredEmailProofRecord> {
    const now = input.now ?? new Date();
    // The courier stores the ticket (did:key) credential only; a held (account) result is kept by the held store.
    if (!isTicketEmailProofResult(input.result)) throw new CourierError('credential-record-invalid', 'Only a ticket email credential is stored here.');
    const base = await createStoredCredentialRecord({
      verified: input.result.verified,
      ownerDid: input.holderDid,
      requirement: input.requirement,
      requirementDigest: input.requirementDigest,
      storedAt: now.toISOString(),
    });
    const record: StoredEmailProofRecord = {
      ...base,
      subjectDid: input.result.envelope.subjectDid,
      descriptor: input.result.descriptor,
    };
    try {
      await this.verify({ record, requirement: input.requirement, holderDid: input.holderDid, now });
    } catch {
      throw new CourierError('credential-record-invalid', 'Issued credential failed offline verification and was not stored. Request a new code.');
    }
    writeOwnerOnly(this.home, credentialFile(this.home, input.holderDid, input.requirementDigest), record);
    return record;
  }
}
