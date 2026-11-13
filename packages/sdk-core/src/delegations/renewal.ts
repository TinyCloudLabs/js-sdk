import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

import { decodeBase64Url } from "../credentials/digest";
import { decodeCanonicalDagCbor } from "./cacao";

const STAMP_DOMAIN = "tinycloud/node/renewal-stamp/v1";
// Bound browser work to one accepted stamp per minute across the node's one-year lease maximum.
// This is a conservative SDK floor; a faster-admitting node history is refused.
const MAX_LEASE_SECONDS = 365 * 24 * 60 * 60;
const MIN_ACCEPTED_RENEWAL_INTERVAL_SECONDS = 60;
export const MAX_RENEWAL_HISTORY_STAMPS =
  Math.ceil(MAX_LEASE_SECONDS / MIN_ACCEPTED_RENEWAL_INTERVAL_SECONDS) + 1;

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
  const stampsByPrevious = new Map<string, RenewalStampHistoryEntry>();
  for (const entry of history) {
    if (entry.lease_cid !== leaseCid) continue;
    if (stampsByPrevious.size >= MAX_RENEWAL_HISTORY_STAMPS) {
      throw new Error("Renewal history is missing or too large");
    }
    if (stampsByPrevious.has(entry.previous_stamp_cid)) {
      throw new Error("Renewal history chain is invalid");
    }
    stampsByPrevious.set(entry.previous_stamp_cid, entry);
  }
  if (stampsByPrevious.size === 0) throw new Error("Renewal history is missing or too large");

  let previousStampCid = leaseCid;
  let previousGeneration = 0;
  let previousEnd: number | undefined;
  let latest: RenewalStampHistoryEntry | undefined;
  while (stampsByPrevious.size > 0) {
    const entry = stampsByPrevious.get(previousStampCid);
    if (!entry) throw new Error("Renewal history chain is invalid");
    stampsByPrevious.delete(previousStampCid);
    if (
      !entry.cid || !Number.isSafeInteger(entry.generation) || entry.generation <= previousGeneration
      || !isSafeUnixSeconds(entry.new_end)
      || (previousEnd !== undefined && entry.new_end <= previousEnd)
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
    previousEnd = entry.new_end;
    previousStampCid = entry.cid;
    latest = entry;
  }

  if (!latest || latest.new_end <= now) throw new Error("Renewal authority has expired");
  return {
    effectiveExpiry: Math.min(latest.new_end, leaseExpiresAt, ancestorEffectiveExpiry ?? Number.MAX_SAFE_INTEGER),
    latestStampCid: latest.cid,
  };
}

/** Public bindings for replaying a durably saved owner lease. No session or key is accepted. */
export interface AdmitOwnerRenewalLeaseInput {
  /** Independently verified canonical space-host origin (HTTPS, or HTTP loopback for local nodes). */
  readonly host: string;
  readonly originalAuthorization: string;
  readonly originalCid: string;
  readonly ownerDid: string;
  readonly agentDid: string;
  readonly spaceId: string;
  readonly nodeIdentity: RenewalNodeIdentity;
  readonly leaseAuthorization: string;
  readonly leaseCid: string;
  /** Exact owner-approved signed lease end. */
  readonly leaseExpiresAt: string;
  readonly signal?: AbortSignal;
}

/** Structurally identical to node-sdk's RenewalLeaseReceipt. */
export interface OwnerRenewalLeaseReceipt {
  readonly originalCid: string;
  readonly leaseCid: string;
  readonly leaseAuthorization: string;
  readonly leaseExpiresAt: string;
  readonly leaseGeneration: 1;
  readonly nodeIdentity: RenewalNodeIdentity;
}

/**
 * Admit already-signed owner authority without restoring the agent's session.
 * Persist both signed authorizations before calling. Retries submit identical
 * bytes and return the same receipt; this function never signs or creates a lease.
 * The node remains authoritative for revocation and live graph admission.
 */
export async function admitOwnerRenewalLease(input: AdmitOwnerRenewalLeaseInput): Promise<OwnerRenewalLeaseReceipt> {
  const { parseSignedSiweCacao } = await import("./cacao");
  const { principalDidEquals } = await import("../identity");
  const { activateSessionWithHost } = await import("../space");
  const origin = new URL(input.host);
  if (origin.origin !== input.host || origin.username || origin.password
    || (origin.protocol !== "https:" && !(origin.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Renewal admission requires a canonical verified node origin");
  }
  assertRenewalNodeIdentity(input.nodeIdentity);
  const original = await parseSignedSiweCacao(input.originalAuthorization.replace(/^Bearer\s+/i, ""), input.originalCid);
  const lease = await parseSignedSiweCacao(input.leaseAuthorization.replace(/^Bearer\s+/i, ""), input.leaseCid);
  const target = `urn:cid:${original.cid}`;
  const resource = lease.attenuation[target];
  const caveats = resource?.["tinycloud.delegation/renew"];
  if (!principalDidEquals(original.issuer, input.ownerDid)
    || !principalDidEquals(original.audience, input.agentDid)
    || !principalDidEquals(lease.issuer, original.issuer)
    || lease.audience !== input.nodeIdentity.renewerDid
    || original.proofs.length !== 0 || lease.proofs.length !== 0
    || !input.spaceId.startsWith("tinycloud:")
    || !Object.keys(original.attenuation).some((key) => key === input.spaceId || key.startsWith(`${input.spaceId}/`))
    || Object.keys(lease.attenuation).length !== 1
    || !resource || Object.keys(resource).length !== 1
    || !Array.isArray(caveats) || caveats.length !== 1
    || typeof caveats[0] !== "object" || caveats[0] === null
    || Array.isArray(caveats[0]) || Object.keys(caveats[0]).length !== 0
    || lease.expiresAt !== input.leaseExpiresAt) {
    throw new Error("Owner renewal lease binding is invalid");
  }
  const now = Date.now();
  const originalEnd = Date.parse(original.expiresAt ?? "");
  const originalStart = Date.parse(original.notBefore ?? original.issuedAt);
  const leaseEnd = Date.parse(lease.expiresAt ?? "");
  const leaseStart = Date.parse(lease.notBefore ?? lease.issuedAt);
  const year = 365 * 24 * 60 * 60 * 1000;
  if (![originalEnd, originalStart, leaseEnd, leaseStart].every(Number.isSafeInteger)
    || originalStart <= 0 || originalStart > now || originalEnd <= now
    || originalEnd <= originalStart || originalEnd - originalStart > 10 * year
    || leaseStart <= 0 || leaseStart > now || leaseEnd <= now
    || leaseEnd <= leaseStart || leaseEnd - leaseStart > year || leaseEnd > now + year) {
    throw new Error("Owner renewal lease validity bounds are invalid or expired");
  }
  // Check the verified host still advertises the identity being admitted.
  const response = await fetch(`${input.host}/.well-known/tinycloud/node-keys`, {
    redirect: "error", signal: input.signal,
  });
  if (!response.ok) throw new Error(`Renewal identity discovery failed: ${response.status}`);
  const current = await response.json() as Partial<RenewalNodeIdentity>;
  if (!current || Object.keys(input.nodeIdentity).some((key) =>
    current[key as keyof RenewalNodeIdentity] !== input.nodeIdentity[key as keyof RenewalNodeIdentity])) {
    throw new Error("Renewal node identity changed");
  }
  // The producer has already admitted the original. Only replay the saved lease.
  const result = await activateSessionWithHost(input.host, {
    Authorization: `Bearer ${input.leaseAuthorization.replace(/^Bearer\s+/i, "")}`,
  }, input.signal);
  if (!result.success) throw new Error(`Owner renewal admission failed: ${result.status} ${result.error ?? ""}`);
  return Object.freeze({
    originalCid: original.cid,
    leaseCid: lease.cid,
    leaseAuthorization: `Bearer ${input.leaseAuthorization.replace(/^Bearer\s+/i, "")}`,
    leaseExpiresAt: input.leaseExpiresAt,
    leaseGeneration: 1,
    nodeIdentity: Object.freeze({ ...input.nodeIdentity }),
  });
}
