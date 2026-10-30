import { CredentialError, canonicalDigest, type IKVService } from "@tinycloud/sdk-core";
import {
  HeldCredentialError,
  parsePkhDid,
  pkhPrincipalsEqual,
  registryKey,
  toChecksumAddress,
  verifyHeldEmailCredential,
  type HeldEmailCredentialOptions,
  type VerifiedHeldEmailCredential,
} from "@tinycloud/sdk-core/held-credentials";

/** A held record whose verified expiry is within this many milliseconds is not offered; the caller re-acquires. */
export const HELD_REUSE_MARGIN_MS = 600_000;

/** True when `expiresAt` is more than `HELD_REUSE_MARGIN_MS` after `now`. Store, find and list share this one boundary. */
function clearsReuseMargin(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() > HELD_REUSE_MARGIN_MS;
}

/** Upper bound on KV list pages under one owner prefix. Beyond it the listing is refused, not partially read. */
const HELD_LIST_MAX_PAGES = 50;

/** Held owners are Ethereum mainnet accounts. Other chains are refused in every held path. */
const HELD_OWNER_CHAIN_ID = "1";

/** A recordId is a canonicalDigest: 43 base64url characters. Anything else never reaches a key. */
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The KV service's error code for a missing key (`ErrorCodes.KV_NOT_FOUND` in sdk-services). */
const KV_NOT_FOUND = "KV_NOT_FOUND";

/** Issuer policy for the S3.1 verifier. The owner and the clock are supplied per call. */
export type HeldIssuerPolicy = Omit<HeldEmailCredentialOptions, "owner" | "now">;

/**
 * Stored shape. Only `credential` is trusted: every read re-verifies it, and no other stored field
 * (email, expiry, subject) is read.
 */
export interface HeldCredentialRecord {
  readonly type: "TinyCloudHeldCredential";
  readonly version: 1;
  readonly ownerDid: string;
  readonly recordId: string;
  readonly credentialDigest: string;
  readonly credential: string;
  readonly storedAt: string;
}

export interface HeldStorageReceipt {
  readonly type: "TinyCloudHeldStorageReceipt";
  readonly version: 1;
  readonly ownerDid: string;
  readonly recordId: string;
  readonly recordDigest: string;
  readonly storedAt: string;
}

/**
 * A stored record that re-verified under the caller's policy, with the verifier's output.
 * `record` is the raw stored value: only `verified` and the summary fields below are authoritative.
 * `recordId`, `email`, `issuedAt`, `expiresAt` and `issuer` are a summary for display. They come from the
 * re-verified credential and from the record key, never from any stored field other than `credential`.
 */
export interface HeldMatch {
  readonly record: HeldCredentialRecord;
  readonly verified: VerifiedHeldEmailCredential;
  /** The record key's id: the digest the store derives from the credential and the owner. */
  readonly recordId: string;
  /** The disclosed email as the credential carries it. */
  readonly email: string;
  /** The signed `iat`. */
  readonly issuedAt: Date;
  /** The signed `exp`. */
  readonly expiresAt: Date;
  /** The issuer DID that signed the credential. */
  readonly issuer: string;
}

/**
 * Canonical account owner: `did:pkh:eip155:1:<EIP-55 address>`.
 * Anything that is not a did:pkh (for example a did:key holder) is refused, and so is any chain other than 1.
 */
export function heldAccountOwner(ownerDid: unknown): string {
  const parsed = parsePkhDid(ownerDid);
  if (parsed === null) {
    throw new CredentialError("ACTIVE_SESSION_REQUIRED", "Held credentials require a did:pkh:eip155 account owner");
  }
  if (parsed.chainId !== HELD_OWNER_CHAIN_ID) {
    throw new CredentialError("ACTIVE_SESSION_REQUIRED", "Held credentials require an Ethereum mainnet (chain 1) account owner");
  }
  return `did:pkh:eip155:${HELD_OWNER_CHAIN_ID}:${toChecksumAddress(parsed.address)}`;
}

/** Key prefix for one owner. Keyed by the lowercase address, so case variants of one owner share it. */
export function heldPrefix(ownerDid: string): string {
  return `v1/held/${registryKey(ownerDid)}/`;
}

export function heldRecordKey(ownerDid: string, recordId: string): string {
  return `${heldPrefix(ownerDid)}${recordId}`;
}

function isHeldRecord(value: unknown): value is HeldCredentialRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "TinyCloudHeldCredential" &&
    record.version === 1 &&
    typeof record.ownerDid === "string" &&
    typeof record.recordId === "string" &&
    typeof record.credentialDigest === "string" &&
    typeof record.credential === "string" &&
    typeof record.storedAt === "string"
  );
}

/** ASCII-only lowercase. Folding of any other kind (dots, plus tags) is deliberately absent. */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * Maps a verifier refusal to a store error. The verifier's subject-owner check surfaces as
 * `nonce-account-mismatch`; the store reports it as HOLDER_MISMATCH. Non-verifier errors pass through.
 */
function refusalFor(error: unknown): unknown {
  if (!(error instanceof HeldCredentialError)) return error;
  const code = error.code === "nonce-account-mismatch" ? "HOLDER_MISMATCH" : "VERIFICATION_FAILED";
  return new CredentialError(code, error.message, { cause: error });
}

function policyOptions(policy: HeldIssuerPolicy, now: Date, owner: string): HeldEmailCredentialOptions {
  return {
    issuerSet: policy.issuerSet,
    acceptedIssuers: policy.acceptedIssuers,
    didMethods: policy.didMethods,
    now,
    owner,
  };
}

export async function createHeldStorageReceipt(record: HeldCredentialRecord): Promise<HeldStorageReceipt> {
  return {
    type: "TinyCloudHeldStorageReceipt",
    version: 1,
    ownerDid: record.ownerDid,
    recordId: record.recordId,
    recordDigest: await canonicalDigest(record),
    storedAt: record.storedAt,
  };
}

/** Owner and holder compares use principal equality, never string equality. */
export async function verifyHeldStorageReceipt(
  record: HeldCredentialRecord,
  receipt: HeldStorageReceipt,
  ownerDid: string,
): Promise<boolean> {
  return (
    receipt.type === "TinyCloudHeldStorageReceipt" &&
    receipt.version === 1 &&
    pkhPrincipalsEqual(receipt.ownerDid, ownerDid) &&
    pkhPrincipalsEqual(record.ownerDid, ownerDid) &&
    receipt.recordId === record.recordId &&
    receipt.storedAt === record.storedAt &&
    receipt.recordDigest === (await canonicalDigest(record))
  );
}

export interface StoreHeldCredentialInput extends HeldIssuerPolicy {
  readonly kv: IKVService;
  readonly ownerDid: unknown;
  readonly sdJwt: unknown;
  readonly now?: Date;
}

/**
 * Store-on-issue. Verifies the SD-JWT itself, writes one record under the owner's prefix, and reads
 * it back. Refuses before any write unless the credential verifies, belongs to the owner, and stays
 * outside the reuse margin.
 */
export async function storeHeldCredential(
  input: StoreHeldCredentialInput,
): Promise<{ readonly record: HeldCredentialRecord; readonly receipt: HeldStorageReceipt }> {
  const now = input.now ?? new Date();
  const owner = heldAccountOwner(input.ownerDid);
  let verified: VerifiedHeldEmailCredential;
  try {
    verified = verifyHeldEmailCredential(input.sdJwt, policyOptions(input, now, owner));
  } catch (error) {
    throw refusalFor(error);
  }
  const sdJwt = input.sdJwt;
  if (typeof sdJwt !== "string") {
    throw new CredentialError("VERIFICATION_FAILED", "Held credential must be an SD-JWT string");
  }
  if (typeof verified.claims.email !== "string") {
    throw new CredentialError("VERIFICATION_FAILED", "Held credential must disclose an email claim");
  }
  if (!clearsReuseMargin(verified.expiresAt, now)) {
    throw new CredentialError("VERIFICATION_FAILED", "Held credential expires within the reuse margin");
  }

  const credentialDigest = await canonicalDigest(sdJwt);
  const recordId = await canonicalDigest({ credentialDigest, holderDid: owner });
  const attempt: HeldCredentialRecord = {
    type: "TinyCloudHeldCredential",
    version: 1,
    ownerDid: owner,
    recordId,
    credentialDigest,
    credential: sdJwt,
    storedAt: now.toISOString(),
  };
  const durable = await writeAndReadBack(input.kv, heldRecordKey(owner, recordId), attempt);
  return { record: durable, receipt: await createHeldStorageReceipt(durable) };
}

/**
 * Writes the attempt and confirms the stored bytes. The comparison covers the identity of the
 * credential, not `storedAt`: a concurrent store of the same credential may have written its own
 * timestamp, and that record is equally valid.
 */
async function writeAndReadBack(kv: IKVService, key: string, attempt: HeldCredentialRecord): Promise<HeldCredentialRecord> {
  const unsaved = () => new CredentialError("VERIFIED_NOT_SAVED", "Held credential could not be confirmed in storage");
  const written = await kv.batchPut([{ key, value: attempt }]).catch(() => undefined);
  if (written?.ok !== true) throw unsaved();
  const readback = await kv.get(key).catch(() => undefined);
  const value: unknown = readback?.ok === true ? readback.data.data : undefined;
  if (
    !isHeldRecord(value) ||
    value.recordId !== attempt.recordId ||
    value.credentialDigest !== attempt.credentialDigest ||
    value.credential !== attempt.credential ||
    !pkhPrincipalsEqual(value.ownerDid, attempt.ownerDid)
  ) {
    throw unsaved();
  }
  return value;
}

type HeldReading =
  | { readonly kind: "verified"; readonly email: string; readonly match: HeldMatch }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" };

/**
 * Reads and judges one stored record. A `kv.get` that throws propagates. A get that resolves not-ok is
 * `invalid`, and the record is left alone. See `judgeHeld` for the rest.
 */
async function readHeld(
  kv: IKVService,
  key: string,
  owner: string,
  policy: HeldIssuerPolicy,
  now: Date,
): Promise<HeldReading> {
  const got = await kv.get(key);
  return judgeHeld(got.ok ? got.data.data : undefined, key, owner, policy, now);
}

/**
 * Re-verifies one stored value. The stored `credential` is the only input trusted. The record must sit
 * under its own recordId key, bind to the owner, and re-verify under the caller's policy.
 * `expired` means the signature verified and the credential is past its expiry: prune may delete it.
 * Every other failure is `invalid` and is left alone.
 */
async function judgeHeld(
  value: unknown,
  key: string,
  owner: string,
  policy: HeldIssuerPolicy,
  now: Date,
): Promise<HeldReading> {
  if (!isHeldRecord(value)) return { kind: "invalid" };
  if (!pkhPrincipalsEqual(value.ownerDid, owner)) return { kind: "invalid" };
  const credentialDigest = await canonicalDigest(value.credential);
  const recordId = await canonicalDigest({ credentialDigest, holderDid: owner });
  if (value.credentialDigest !== credentialDigest || value.recordId !== recordId || key !== heldRecordKey(owner, recordId)) {
    return { kind: "invalid" };
  }
  let verified: VerifiedHeldEmailCredential;
  try {
    verified = verifyHeldEmailCredential(value.credential, policyOptions(policy, now, owner));
  } catch (error) {
    if (!(error instanceof HeldCredentialError)) throw error;
    return { kind: error.code === "expired" ? "expired" : "invalid" };
  }
  const email = verified.claims.email;
  if (typeof email !== "string") return { kind: "invalid" };
  const match: HeldMatch = {
    record: value,
    verified,
    recordId,
    email,
    issuedAt: verified.issuedAt,
    expiresAt: verified.expiresAt,
    issuer: verified.issuer,
  };
  return { kind: "verified", email, match };
}

/** Listing refused beyond the page limit. Keeps the VERIFICATION_FAILED wire code; recovery callers test for this subclass. */
export class HeldListingLimitError extends CredentialError {}

/**
 * Lists every key under the owner prefix by following cursors, each key once (a listing that repeats a key
 * must not make prune compare a record with itself, or the list return it twice). Returns undefined when the
 * KV list call fails. Refuses a truncated listing with no cursor, and any listing beyond the page limit.
 */
async function listHeldKeys(kv: IKVService, prefix: string): Promise<readonly string[] | undefined> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < HELD_LIST_MAX_PAGES; page += 1) {
    const listing = await kv.list(cursor === undefined ? { prefix } : { prefix, cursor });
    if (!listing.ok) return undefined;
    keys.push(...listing.data.keys);
    if (!listing.data.truncated) return [...new Set(keys)];
    const next = listing.data.nextCursor;
    if (next === undefined || next === "") {
      throw new CredentialError("VERIFICATION_FAILED", "Held listing is truncated without a continuation cursor");
    }
    cursor = next;
  }
  throw new HeldListingLimitError("VERIFICATION_FAILED", "Held listing exceeds the page limit");
}

export interface FindHeldCredentialInput extends HeldIssuerPolicy {
  readonly kv: IKVService;
  readonly ownerDid: unknown;
  readonly email: string;
  readonly now?: Date;
}

/**
 * Owner-scoped read. Lists only `v1/held/<registryKey>/`, so `v1/records/` is never considered.
 * Returns the verified record with the latest expiry that still clears the reuse margin, or undefined.
 */
export async function findHeldCredential(input: FindHeldCredentialInput): Promise<HeldMatch | undefined> {
  const now = input.now ?? new Date();
  const owner = heldAccountOwner(input.ownerDid);
  const keys = await listHeldKeys(input.kv, heldPrefix(owner));
  if (keys === undefined) return undefined;
  const wanted = asciiLowercase(input.email);
  let best: HeldMatch | undefined;
  for (const key of keys) {
    const reading = await readHeld(input.kv, key, owner, input, now);
    if (reading.kind !== "verified" || reading.email !== wanted) continue;
    const expiresAt = reading.match.verified.expiresAt.getTime();
    if (!clearsReuseMargin(reading.match.verified.expiresAt, now)) continue;
    if (best === undefined || expiresAt > best.verified.expiresAt.getTime()) best = reading.match;
  }
  return best;
}

export type ListHeldEmailCredentialsInput = Omit<FindHeldCredentialInput, "email"> & {
  /** Accepted so a `FindHeldCredentialInput` can be passed as is. Ignored: the listing is never filtered by email. */
  readonly email?: string;
};

/**
 * Lists the account's own VALID held email credentials. Owner-only: it reads `v1/held/<registryKey>/` for the
 * canonical `ownerDid` and nothing else, and refuses any owner that is not an Ethereum mainnet did:pkh.
 *
 * Returns every valid record, not one per email: no email filter and no "latest" pick. Expired records and
 * records the verifier refuses (status other than none, issuer retired or not accepted, bad signature) are
 * EXCLUDED. Validity is what `findHeldCredential` applies: re-verification plus the reuse margin. A record is
 * listed only if it is valid for at least 10 more minutes, meaning its expiry is more than `HELD_REUSE_MARGIN_MS`
 * after `now`. A record exactly at the margin is excluded, as in `findHeldCredential`, so the screen never offers
 * a record that `findHeldCredential` or a presentation would refuse.
 *
 * Order: newest `issuedAt` first; equal `issuedAt` by ascending `recordId`. Returns `[]` when there are none.
 *
 * Throws if the store cannot be read; skips records that fail verification. A record that is corrupt,
 * malformed or fails verification is skipped silently, never reported and never thrown. A store failure is
 * not a bad record, so the screen can tell "none" from "unreachable": a `kv.get` or `kv.list` that throws
 * propagates, and one that resolves not-ok is an `OFFLINE` CredentialError (a key that is gone by the time it
 * is read, `KV_NOT_FOUND`, is skipped). A refused owner, or a listing that is truncated or beyond the page
 * limit, also throws. `findHeldCredential` is looser: it reads a failed `kv.list` as "not found".
 * Every returned summary field comes from the re-verified credential, never from other stored fields.
 * `record` is the raw stored value; only the `verified` fields and the summary above are authoritative.
 */
export async function listHeldEmailCredentials(input: ListHeldEmailCredentialsInput): Promise<readonly HeldMatch[]> {
  const now = input.now ?? new Date();
  const owner = heldAccountOwner(input.ownerDid);
  const keys = await listHeldKeys(input.kv, heldPrefix(owner));
  if (keys === undefined) throw new CredentialError("OFFLINE", "Held credentials could not be listed");
  const matches: HeldMatch[] = [];
  for (const key of keys) {
    const got = await input.kv.get(key);
    if (!got.ok) {
      if ("error" in got && got.error.code === KV_NOT_FOUND) continue;
      throw new CredentialError("OFFLINE", "A held credential could not be read");
    }
    let reading: HeldReading;
    try {
      reading = await judgeHeld(got.data.data, key, owner, input, now);
    } catch {
      continue;
    }
    if (reading.kind === "verified" && clearsReuseMargin(reading.match.verified.expiresAt, now)) matches.push(reading.match);
  }
  return matches.sort((a, b) => {
    const newestFirst = b.issuedAt.getTime() - a.issuedAt.getTime();
    if (newestFirst !== 0) return newestFirst;
    return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  });
}

/**
 * Deletes the named record key only. The recordId is validated first, so a caller-supplied value cannot
 * address another key. Copies outside this store remain valid until their own expiry.
 */
export async function deleteHeldCredential(input: {
  readonly kv: IKVService;
  readonly ownerDid: unknown;
  readonly recordId: string;
}): Promise<boolean> {
  const owner = heldAccountOwner(input.ownerDid);
  if (!RECORD_ID_PATTERN.test(input.recordId)) {
    throw new CredentialError("DESCRIPTOR_INVALID", "recordId must be a 43-character base64url digest");
  }
  const result = await input.kv.delete(heldRecordKey(owner, input.recordId));
  return result.ok;
}

export interface PruneHeldCredentialsInput extends HeldIssuerPolicy {
  readonly kv: IKVService;
  readonly ownerDid: unknown;
  readonly now?: Date;
}

/**
 * Refresh housekeeping for one owner. Deletes records whose signature verifies but whose expiry has
 * passed, and for each email keeps only the verified record with the newest expiry. Unverifiable records
 * are left in place: prune cannot tell a forgery from a policy mismatch, so it never deletes on that basis.
 * Returns the keys actually removed.
 */
export async function pruneHeldCredentials(input: PruneHeldCredentialsInput): Promise<readonly string[]> {
  const now = input.now ?? new Date();
  const owner = heldAccountOwner(input.ownerDid);
  const keys = await listHeldKeys(input.kv, heldPrefix(owner));
  if (keys === undefined) return [];
  const doomed: string[] = [];
  const newestByEmail = new Map<string, { readonly key: string; readonly recordId: string; readonly expiresAt: number }>();
  for (const key of keys) {
    const reading = await readHeld(input.kv, key, owner, input, now);
    if (reading.kind === "invalid") continue;
    if (reading.kind === "expired") {
      doomed.push(key);
      continue;
    }
    const candidate = {
      key,
      recordId: reading.match.record.recordId,
      expiresAt: reading.match.verified.expiresAt.getTime(),
    };
    const current = newestByEmail.get(reading.email);
    if (current === undefined) {
      newestByEmail.set(reading.email, candidate);
      continue;
    }
    const candidateWins =
      candidate.expiresAt > current.expiresAt ||
      (candidate.expiresAt === current.expiresAt && candidate.recordId > current.recordId);
    newestByEmail.set(reading.email, candidateWins ? candidate : current);
    doomed.push(candidateWins ? current.key : candidate.key);
  }
  const removed: string[] = [];
  for (const key of doomed) {
    const result = await input.kv.delete(key);
    if (result.ok) removed.push(key);
  }
  return removed;
}
