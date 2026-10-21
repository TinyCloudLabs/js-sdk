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

/** Pending files are keyed by a hash of the address so mailbox addresses never appear in file names. */
function pendingFile(home: string, address: string): string {
  return path.join(credentialsDir(home), `pending-${sha256Hex(address)}.json`);
}

function ensureSecureDir(home: string): void {
  const dir = credentialsDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Temp file (0600, exclusive create) then rename, so readers never see a partial write. */
function writeOwnerOnly(home: string, file: string, obj: unknown): void {
  ensureSecureDir(home);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

function readOwnerOnly<T>(home: string, file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  const dirMode = fs.statSync(credentialsDir(home)).mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    throw new CourierError('credential-permissions', `${credentialsDir(home)} must be owner-only (mode 0700); found mode ${dirMode.toString(8)}.`);
  }
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CourierError('credential-permissions', `${path.basename(file)} must be owner-only (mode 0600); found mode ${mode.toString(8)}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    throw new CourierError('credential-store-invalid', `Invalid credential store file ${path.basename(file)}.`);
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

export function savePendingEmailProof(pending: EmailProofPending, home = profileDir()): void {
  writeOwnerOnly(home, pendingFile(home, pending.address), pending);
}

/**
 * Load and consume the pending email proof for `address`. An expired or malformed
 * pending file is deleted here; the caller deletes it again on success or failure.
 */
export function takePendingEmailProof(address: string, now: Date = new Date(), home = profileDir()): EmailProofPending {
  const file = pendingFile(home, address);
  const pending = readOwnerOnly<EmailProofPending>(home, file);
  if (!pending) {
    throw new CourierError('credential-request-missing', `No pending verification for ${address}. Run \`courier credential acquire --email ${address}\` first.`);
  }
  if (pending.type !== 'TinyCloudEmailProofPending' || pending.version !== 1 || pending.address !== address) {
    removeFile(file);
    throw new CourierError('credential-store-invalid', 'Pending verification file is invalid and was deleted.');
  }
  if (Date.parse(pending.expiresAt) <= now.getTime()) {
    removeFile(file);
    throw new CourierError('credential-session-expired', `Verification for ${address} expired. Run \`courier credential acquire --email ${address}\` again.`);
  }
  return pending;
}

export function removePendingEmailProof(address: string, home = profileDir()): void {
  removeFile(pendingFile(home, address));
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
