import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, fromBase64Url } from "@tinycloud/share-envelope";
import { computeOwnerShareRegistrationCid, OWNER_SHARE_REGISTRATION_DOMAIN, type OwnerSharePolicyRegistration } from "../../owner-policy.js";

/**
 * Policy/v2 node registration receipt, with expiry reported apart from
 * invalidity (design C4). Security-sensitive.
 *
 * The package's `validateOwnerSharePolicyRegistration` refuses an expired
 * receipt before checking anything else, so an expired-but-genuine receipt
 * cannot be told from a forged one. This verifier makes the same checks
 * (exact shape; binding to the chain's CIDs; every field the original compares
 * against the canonical policy and the enforcement facts; canonical times;
 * the CID over the canonical core; the node's Ed25519 signature against the
 * registration key from the share public config) and then reports `expired`
 * separately. `registrationCid` is not inside the node-signed core, so the
 * CID-over-core check is what binds it.
 */
export interface RegistrationKey {
  readonly kid: string;
  /** Raw 32-byte Ed25519 key, or its 34-byte did:key multicodec form. */
  readonly publicKey: Uint8Array;
}

export interface CheckedRegistration {
  readonly status: "valid" | "expired";
  readonly registration: OwnerSharePolicyRegistration;
}

const REGISTRATION_KEYS = ["registrationCid", "policyCid", "ownerDelegationCid", "enforcementDelegationCid", "ownerDid", "shareKeyDid", "enforcerDid", "shareId", "recipientMatcher", "target", "resource", "actions", "contentSource", "contentSourceDigest", "registeredAt", "expiresAt"];

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("registration receipt is malformed");
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) throw new Error("registration receipt has unknown or missing fields");
  return value as Record<string, unknown>;
}

function canonicalTime(value: unknown): number {
  if (typeof value !== "string") throw new Error("registration time is invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error("registration time is not canonical");
  return parsed;
}

function matches(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && canonicalize(left) === canonicalize(right);
}

/** Throws when the receipt does not verify; reports a verified receipt past its `expiresAt` as `expired`. */
export function checkRegistrationReceipt(
  value: unknown,
  expected: {
    readonly policyCid: string; readonly ownerDelegationCid: string; readonly enforcementDelegationCid: string;
    /** The `policy` object of the canonical Policy/v2 envelope whose bytes hash to `policyCid`. */
    readonly policy: Readonly<Record<string, unknown>>;
    /** The verified enforcement delegation's facts. */
    readonly enforcementFacts: Readonly<Record<string, unknown>>;
  },
  key: RegistrationKey,
  now: Date,
): CheckedRegistration {
  const root = exactObject(value, ["registration", "proof"]);
  const registration = exactObject(root.registration, REGISTRATION_KEYS);
  const proof = exactObject(root.proof, ["alg", "kid", "signature"]);
  const { policy, enforcementFacts: facts } = expected;
  if (registration.policyCid !== expected.policyCid || registration.ownerDelegationCid !== expected.ownerDelegationCid || registration.enforcementDelegationCid !== expected.enforcementDelegationCid || registration.contentSourceDigest !== policy.contentSourceDigest) {
    throw new Error("registration is not bound to the record's chain");
  }
  // The same comparisons as validateOwnerSharePolicyRegistration: the receipt restates the policy and the facts exactly.
  const target = policy.target as Record<string, unknown> | undefined;
  const resource = policy.resource as Record<string, unknown> | undefined;
  const registrationTarget = registration.target as Record<string, unknown> | undefined;
  const registrationResource = registration.resource as Record<string, unknown> | undefined;
  if (typeof target?.origin !== "string" || typeof target.nodeAudience !== "string" || typeof target.enforcerDid !== "string" || typeof target.spaceId !== "string"
    || typeof resource?.kind !== "string" || !["exact", "prefix"].includes(resource.kind) || typeof resource.path !== "string" || !Array.isArray(policy.actions)
    || registrationTarget === undefined || registrationResource === undefined
    || policy.ownerDid !== registration.ownerDid || policy.shareKeyDid !== registration.shareKeyDid || policy.shareId !== registration.shareId
    || !matches(policy.recipientMatcher, registration.recipientMatcher)
    || target.origin !== registrationTarget.origin || target.nodeAudience !== registrationTarget.nodeAudience || target.enforcerDid !== registration.enforcerDid || target.spaceId !== registrationTarget.spaceId
    || resource.kind !== registrationResource.kind || resource.path !== registrationResource.path
    || !matches(policy.actions, registration.actions) || !matches(policy.contentSource, registration.contentSource) || policy.expiresAt !== registration.expiresAt
    || facts.ownerDelegationCid !== registration.ownerDelegationCid || facts.policyCid !== registration.policyCid || facts.shareKeyDid !== registration.shareKeyDid || facts.enforcerDid !== registration.enforcerDid
    || facts.nodeAudience !== registrationTarget.nodeAudience || facts.spaceId !== registrationTarget.spaceId || facts.path !== registrationResource.path
    || !matches(facts.actions, registration.actions) || facts.expiresAt !== registration.expiresAt) {
    throw new Error("registration is not bound to the canonical policy");
  }
  canonicalTime(registration.registeredAt);
  const expiresAt = canonicalTime(registration.expiresAt);
  const { registrationCid, ...core } = registration;
  if (typeof registrationCid !== "string" || computeOwnerShareRegistrationCid(core as unknown as Omit<OwnerSharePolicyRegistration, "registrationCid">) !== registrationCid) throw new Error("registration CID does not match its canonical core");
  if (proof.alg !== "EdDSA" || proof.kid !== key.kid || typeof proof.signature !== "string") throw new Error("registration proof key is not trusted");
  const publicKey = key.publicKey.length === 34 && key.publicKey[0] === 0xed && key.publicKey[1] === 0x01 ? key.publicKey.slice(2) : key.publicKey;
  if (publicKey.length !== 32) throw new Error("registration key is invalid");
  const signature = fromBase64Url(proof.signature);
  const signed = new TextEncoder().encode(`${OWNER_SHARE_REGISTRATION_DOMAIN}${canonicalize(core)}`);
  if (signature.length !== 64 || !ed25519.verify(signature, signed, publicKey, { zip215: false })) throw new Error("registration proof signature is invalid");
  return { status: expiresAt <= now.getTime() ? "expired" : "valid", registration: registration as unknown as OwnerSharePolicyRegistration };
}
