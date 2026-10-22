import { CredentialError, canonicalDigest, type IKVService } from "@tinycloud/sdk-core";
import {
  parsePkhDid,
  pkhPrincipalsEqual,
  registryKey,
  toChecksumAddress,
  type VerifiedHeldCredential,
} from "@tinycloud/sdk-core/held-credentials";

/** A held record expiring within this many milliseconds is not offered; the caller re-acquires. */
export const HELD_REUSE_MARGIN_MS = 600_000;

export interface HeldCredentialRecord {
  readonly type: "TinyCloudHeldCredential";
  readonly version: 1;
  readonly ownerDid: string;
  readonly recordId: string;
  readonly credentialDigest: string;
  readonly credential: string;
  readonly issuer: string;
  readonly subject: string;
  readonly subjectAddress: string;
  readonly credentialId: string;
  readonly profile: string;
  readonly profileVersion: number;
  readonly vct: string;
  readonly email: string;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
  readonly storedAt: string;
}

export interface HeldStorageReceipt {
  readonly type: "TinyCloudHeldStorageReceipt";
  readonly version: 1;
  readonly ownerDid: string;
  readonly recordId: string;
  readonly recordDigest: string;
  readonly storedAt: string;
  readonly etag?: string;
}

/**
 * Canonical account owner: `did:pkh:eip155:<chain>:<EIP-55 address>`.
 * Anything that is not a did:pkh (for example a did:key holder) is refused.
 */
export function heldAccountOwner(ownerDid: unknown): string {
  const parsed = parsePkhDid(ownerDid);
  if (!parsed) throw new CredentialError("ACTIVE_SESSION_REQUIRED", "Held credentials require an account owner (did:pkh:eip155)");
  return `did:pkh:eip155:${parsed.chainId}:${toChecksumAddress(parsed.address)}`;
}

/** Key prefix for one owner. Keyed by the lowercase address, so case variants of one owner share it. */
export function heldPrefix(ownerDid: string): string {
  return `v1/held/${registryKey(ownerDid)}/`;
}

export function heldRecordKey(ownerDid: string, recordId: string): string {
  return `${heldPrefix(ownerDid)}${recordId}`;
}

function isHeldRecord(value: unknown): value is HeldCredentialRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === "TinyCloudHeldCredential" && item.version === 1 && typeof item.ownerDid === "string" && typeof item.recordId === "string" && typeof item.credentialDigest === "string" && typeof item.credential === "string" && typeof item.email === "string" && typeof item.expiresAt === "string" && typeof item.storedAt === "string";
}

/** ASCII-only lowercase. Folding of any other kind (dots, plus tags) is deliberately absent. */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

export async function createHeldStorageReceipt(record: HeldCredentialRecord, etag?: string): Promise<HeldStorageReceipt> {
  return Object.freeze({
    type: "TinyCloudHeldStorageReceipt",
    version: 1,
    ownerDid: record.ownerDid,
    recordId: record.recordId,
    recordDigest: await canonicalDigest(record),
    storedAt: record.storedAt,
    ...(etag === undefined ? {} : { etag }),
  });
}

/** Owner and holder compares use principal equality, never string equality. */
export async function verifyHeldStorageReceipt(record: HeldCredentialRecord, receipt: HeldStorageReceipt, ownerDid: string): Promise<boolean> {
  return receipt.type === "TinyCloudHeldStorageReceipt" && receipt.version === 1 && pkhPrincipalsEqual(receipt.ownerDid, ownerDid) && pkhPrincipalsEqual(record.ownerDid, ownerDid) && receipt.recordId === record.recordId && receipt.storedAt === record.storedAt && receipt.recordDigest === (await canonicalDigest(record));
}

/**
 * Store-on-issue. Writes one record under the owner's prefix, reads it back, and verifies the receipt.
 * Refuses without an account owner before any write.
 */
export async function storeHeldCredential(input: {
  readonly kv: IKVService;
  readonly verified: VerifiedHeldCredential;
  readonly sdJwt: string;
  readonly ownerDid: string | undefined;
  readonly now?: Date;
}): Promise<{ readonly record: HeldCredentialRecord; readonly receipt: HeldStorageReceipt }> {
  const owner = heldAccountOwner(input.ownerDid);
  if (!pkhPrincipalsEqual(input.verified.subject, owner)) throw new CredentialError("HOLDER_MISMATCH", "Held credential subject is not the account owner");
  const rawEmail = input.verified.claims.email;
  if (typeof rawEmail !== "string" || rawEmail.length === 0) throw new CredentialError("VERIFICATION_FAILED", "Held credential has no email claim");
  const email = asciiLowercase(rawEmail);
  const credentialDigest = await canonicalDigest(input.sdJwt);
  const recordId = await canonicalDigest({ credentialDigest, holderDid: owner });
  const record: HeldCredentialRecord = Object.freeze({
    type: "TinyCloudHeldCredential",
    version: 1,
    ownerDid: owner,
    recordId,
    credentialDigest,
    credential: input.sdJwt,
    issuer: input.verified.issuer,
    subject: input.verified.subject,
    subjectAddress: input.verified.subjectAddress,
    credentialId: input.verified.credentialId,
    profile: input.verified.profile,
    profileVersion: input.verified.profileVersion,
    vct: input.verified.vct,
    email,
    claims: input.verified.claims,
    expiresAt: input.verified.expiresAt.toISOString(),
    storedAt: (input.now ?? new Date()).toISOString(),
  });
  const key = heldRecordKey(owner, recordId);
  const written = await input.kv.batchPut([{ key, value: record }]);
  if (!written.ok) throw new CredentialError("VERIFIED_NOT_SAVED", "Held credential could not be saved");
  const readback = await input.kv.get<HeldCredentialRecord>(key);
  if (!readback.ok || !isHeldRecord(readback.data.data) || (await canonicalDigest(readback.data.data)) !== (await canonicalDigest(record))) throw new CredentialError("VERIFIED_NOT_SAVED", "Held credential durable storage could not be confirmed");
  const stored = readback.data.data;
  const receipt = await createHeldStorageReceipt(stored, readback.data.headers.etag);
  if (!(await verifyHeldStorageReceipt(stored, receipt, owner))) throw new CredentialError("VERIFIED_NOT_SAVED", "Held credential storage receipt is invalid");
  return { record: stored, receipt };
}

/**
 * Owner-scoped read. Lists only `v1/held/<registryKey>/`, so `v1/records/` is never considered.
 * Returns the matching record with the latest expiry, or undefined.
 */
export async function findHeldCredential(input: {
  readonly kv: IKVService;
  readonly ownerDid: string | undefined;
  readonly email: string;
  readonly now?: Date;
}): Promise<HeldCredentialRecord | undefined> {
  const owner = heldAccountOwner(input.ownerDid);
  const wanted = asciiLowercase(input.email);
  const now = (input.now ?? new Date()).getTime();
  const listing = await input.kv.list({ prefix: heldPrefix(owner) });
  if (!listing.ok) return undefined;
  let best: HeldCredentialRecord | undefined;
  let bestExpiry = Number.NEGATIVE_INFINITY;
  for (const key of listing.data.keys.sort()) {
    const result = await input.kv.get<HeldCredentialRecord>(key);
    if (!result.ok || !isHeldRecord(result.data.data)) continue;
    const record = result.data.data;
    if (key !== heldRecordKey(owner, record.recordId)) continue;
    if (!pkhPrincipalsEqual(record.ownerDid, owner)) continue;
    if (record.email !== wanted) continue;
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiry)) continue;
    if (expiry <= now) continue;
    if (expiry - now < HELD_REUSE_MARGIN_MS) continue;
    if (expiry > bestExpiry) {
      best = record;
      bestExpiry = expiry;
    }
  }
  return best;
}

/** Deletes the named record key only. Copies outside this store remain valid until their own expiry. */
export async function deleteHeldCredential(input: { readonly kv: IKVService; readonly ownerDid: string | undefined; readonly recordId: string }): Promise<boolean> {
  const owner = heldAccountOwner(input.ownerDid);
  return (await input.kv.delete(heldRecordKey(owner, input.recordId))).ok;
}

/**
 * Refresh housekeeping for one owner. Deletes expired records, and for each email keeps only the
 * record with the newest expiry. Returns the keys actually removed.
 */
export async function pruneHeldCredentials(input: { readonly kv: IKVService; readonly ownerDid: string | undefined; readonly now?: Date }): Promise<readonly string[]> {
  const owner = heldAccountOwner(input.ownerDid);
  const now = (input.now ?? new Date()).getTime();
  const listing = await input.kv.list({ prefix: heldPrefix(owner) });
  if (!listing.ok || listing.data.truncated) return [];
  const doomed: string[] = [];
  const newestByEmail = new Map<string, { readonly key: string; readonly expiry: number }>();
  for (const key of listing.data.keys.sort()) {
    const result = await input.kv.get<HeldCredentialRecord>(key);
    if (!result.ok || !isHeldRecord(result.data.data)) continue;
    const record = result.data.data;
    if (key !== heldRecordKey(owner, record.recordId)) continue;
    if (!pkhPrincipalsEqual(record.ownerDid, owner)) continue;
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiry)) continue;
    if (expiry <= now) {
      doomed.push(key);
      continue;
    }
    const current = newestByEmail.get(record.email);
    if (current === undefined) {
      newestByEmail.set(record.email, { key, expiry });
    } else if (expiry > current.expiry) {
      doomed.push(current.key);
      newestByEmail.set(record.email, { key, expiry });
    } else {
      doomed.push(key);
    }
  }
  const removed: string[] = [];
  for (const key of doomed) {
    if ((await input.kv.delete(key)).ok) removed.push(key);
  }
  return removed;
}
