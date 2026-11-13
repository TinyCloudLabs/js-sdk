import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

import { decodeBase64Url } from "../credentials/digest";
import { decodeCanonicalDagCbor } from "./cacao";

const STAMP_DOMAIN = "tinycloud/node/renewal-stamp/v1";
const MAX_HISTORY_STAMPS = 128;

export interface RenewalStampHistoryEntry {
  readonly cid: string;
  readonly lease_cid: string;
  readonly generation: number;
  readonly previous_stamp_cid: string;
  readonly new_end: number;
  readonly signed_bytes: string;
  readonly signature: string;
}

export interface RenewalNodeIdentity {
  readonly nodeDid: string;
  readonly renewerDid: string;
  /** Raw Ed25519 key, base64url without padding. */
  readonly renewerPublicKey: string;
  readonly renewerEpoch: number;
}

export interface VerifyRenewalHistoryInput {
  readonly originalCid: string;
  readonly leaseCid: string;
  /** Owner-signed lease expiry, in Unix seconds. */
  readonly leaseExpiresAt: number;
  /** Current ancestor authority bound, derived from signed grants and live status. */
  readonly ancestorEffectiveExpiry?: number;
  readonly nodeIdentity: RenewalNodeIdentity;
  /** Raw, untrusted node status data. It is accepted only after each stamp is independently verified. */
  readonly history: readonly RenewalStampHistoryEntry[];
  /** Current Unix time in seconds. */
  readonly now: number;
}

export interface VerifiedRenewalHistory {
  readonly effectiveExpiry: number;
  readonly latestStampCid: string;
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error(`${label} must be a map`);
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return result;
}

function isSafeUnixSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseCanonicalExpiry(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new Error("Renewal stamp expiry is invalid");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1000 !== 0) {
    throw new Error("Renewal stamp expiry is invalid");
  }
  const canonical = new Date(milliseconds).toISOString().replace(".000Z", "Z");
  if (canonical !== value) throw new Error("Renewal stamp expiry is not canonical");
  return milliseconds / 1000;
}

function renewalPublicKey(identity: RenewalNodeIdentity): Uint8Array {
  if (!identity.renewerDid.startsWith("did:key:z") || !Number.isSafeInteger(identity.renewerEpoch) || identity.renewerEpoch < 0) {
    throw new Error("Node renewal identity is invalid");
  }
  const publicKey = decodeBase64Url(identity.renewerPublicKey);
  if (publicKey.length !== 32) throw new Error("Node renewal public key is invalid");
  const identifier = identity.renewerDid.slice("did:key:".length);
  const multicodec = bases.base58btc.decode(identifier);
  if (
    multicodec.length !== 34 || multicodec[0] !== 0xed || multicodec[1] !== 0x01
    || bases.base58btc.encode(multicodec) !== identifier
    || !multicodec.slice(2).every((byte, index) => byte === publicKey[index])
  ) {
    throw new Error("Node renewal key does not match its DID");
  }
  return publicKey;
}

/** Validate the public node and renewer identities before signing or trusting them. */
export function assertRenewalNodeIdentity(identity: RenewalNodeIdentity): void {
  if (!identity.nodeDid.startsWith("did:key:z")) throw new Error("Node renewal identity is invalid");
  const nodeIdentifier = identity.nodeDid.slice("did:key:".length);
  const nodeMulticodec = bases.base58btc.decode(nodeIdentifier);
  if (
    nodeMulticodec.length !== 34 || nodeMulticodec[0] !== 0xed || nodeMulticodec[1] !== 0x01
    || bases.base58btc.encode(nodeMulticodec) !== nodeIdentifier
  ) {
    throw new Error("Node identity is invalid");
  }
  renewalPublicKey(identity);
}

function stampCid(bytes: Uint8Array): string {
  return CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString();
}

/**
 * Verify a node-admitted renewal chain. Original signed expiry is the initial
 * grant end. The result is bounded by the owner-signed lease and any
 * independently verified ancestor bound supplied by the caller.
 */
export function verifyRenewalHistory(input: VerifyRenewalHistoryInput): VerifiedRenewalHistory {
  const {
    originalCid,
    leaseCid,
    leaseExpiresAt,
    ancestorEffectiveExpiry,
    nodeIdentity,
    history,
    now,
  } = input;
  if (
    !originalCid || !leaseCid || !isSafeUnixSeconds(leaseExpiresAt)
    || !isSafeUnixSeconds(now) || now >= leaseExpiresAt
    || (ancestorEffectiveExpiry !== undefined && !isSafeUnixSeconds(ancestorEffectiveExpiry))
  ) {
    throw new Error("Renewal authority bounds are invalid");
  }
  assertRenewalNodeIdentity(nodeIdentity);
  const publicKey = renewalPublicKey(nodeIdentity);
  const remaining = history.filter((entry) => entry.lease_cid === leaseCid);
  if (remaining.length === 0 || remaining.length > MAX_HISTORY_STAMPS) {
    throw new Error("Renewal history is missing or too large");
  }

  let previousStampCid = leaseCid;
  let previousGeneration = 0;
  let latest: RenewalStampHistoryEntry | undefined;
  while (remaining.length > 0) {
    const matching = remaining
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.previous_stamp_cid === previousStampCid);
    if (matching.length !== 1) throw new Error("Renewal history chain is invalid");
    const [{ entry, index }] = matching;
    if (
      !entry.cid || !Number.isSafeInteger(entry.generation) || entry.generation <= 0
      || entry.generation < previousGeneration || !isSafeUnixSeconds(entry.new_end)
      || entry.new_end > leaseExpiresAt
      || (ancestorEffectiveExpiry !== undefined && entry.new_end > ancestorEffectiveExpiry)
    ) {
      throw new Error("Renewal history chain is invalid");
    }
    const bytes = decodeBase64Url(entry.signed_bytes);
    const signature = decodeBase64Url(entry.signature);
    if (bytes.length === 0 || signature.length !== 64 || stampCid(bytes) !== entry.cid) {
      throw new Error("Renewal stamp bytes are invalid");
    }
    if (!ed25519.verify(signature, bytes, publicKey, { zip215: false })) {
      throw new Error("Renewal stamp signature is invalid");
    }
    const outer = record(decodeCanonicalDagCbor(bytes), "Renewal stamp", ["domain", "unsigned"]);
    if (outer.domain !== STAMP_DOMAIN) throw new Error("Renewal stamp domain is invalid");
    const unsigned = record(outer.unsigned, "Renewal stamp payload", [
      "type", "newEnd", "nodeDid", "version", "leaseCid", "originalCid",
      "renewerEpoch", "leaseGeneration", "previousStampCid",
    ]);
    if (
      unsigned.type !== "TinyCloudRenewalStamp" || unsigned.version !== 1
      || unsigned.originalCid !== originalCid || unsigned.leaseCid !== leaseCid
      || unsigned.leaseGeneration !== entry.generation || unsigned.previousStampCid !== previousStampCid
      || unsigned.nodeDid !== nodeIdentity.nodeDid || unsigned.renewerEpoch !== nodeIdentity.renewerEpoch
      || parseCanonicalExpiry(unsigned.newEnd) !== entry.new_end
    ) {
      throw new Error("Renewal stamp binding is invalid");
    }
    previousGeneration = entry.generation;
    previousStampCid = entry.cid;
    latest = entry;
    remaining.splice(index, 1);
  }

  if (!latest || latest.new_end <= now) throw new Error("Renewal authority has expired");
  return {
    effectiveExpiry: Math.min(latest.new_end, leaseExpiresAt, ancestorEffectiveExpiry ?? Number.MAX_SAFE_INTEGER),
    latestStampCid: latest.cid,
  };
}
