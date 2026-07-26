import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base32 } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { sha256 as sha256Cid } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { base58btc } from "multiformats/bases/base58";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";

export interface OwnerDelegationReceipt {
  readonly delegationCid: string;
  readonly signedDagCbor: Uint8Array;
  readonly delegation: { readonly delegateDID: string; readonly spaceId: string; readonly path: string; readonly actions: readonly string[]; readonly expiry: Date };
}

export interface CreateOwnerDelegationParams {
  readonly delegateDid: string;
  readonly spaceId: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly expiresAt: Date;
}

const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
const ENFORCEMENT_DOMAIN = "xyz.tinycloud.share/policy-enforcement/v2\\0";
const POLICY_DOMAIN = "xyz.tinycloud.share/policy/v2\\0";

export type OwnerShareAction = "tinycloud.kv/get" | "tinycloud.kv/metadata" | "tinycloud.kv/put";
export type OwnerShareMatcher =
  | { readonly kind: "exactEmail"; readonly value: string }
  | { readonly kind: "emailDomain"; readonly value: string };

export interface OwnerSharePolicyV2 {
  readonly type: "TinyCloudSharePolicy";
  readonly version: 2;
  readonly shareId: string;
  readonly ownerDid: string;
  readonly shareKeyDid: string;
  readonly recipientMatcher: OwnerShareMatcher;
  readonly target: { readonly origin: string; readonly nodeAudience: string; readonly enforcerDid: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact"; readonly path: string };
  readonly actions: readonly OwnerShareAction[];
  readonly contentSource: { readonly kind: "kv"; readonly space: string; readonly path: string };
  readonly contentSourceDigest: string;
  readonly ownerDelegationCid: string;
  readonly expiresAt: string;
}

export interface DelegatedShareKey {
  readonly did: string;
  readonly publicKey: Uint8Array;
  readonly extractable: boolean;
  readonly privateJwk?: Record<string, string>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  clear(): void;
}

export interface SignedDelegation {
  readonly cid: string;
  readonly dagCbor: string;
  readonly issuerDid: string;
  readonly audienceDid: string;
  readonly facts: Record<string, string | readonly string[]>;
  readonly signature: string;
}

export interface RegisterOwnerSharePolicyParams {
  readonly policy: { readonly bytes: Uint8Array; readonly cid: string; readonly proof: string };
  readonly ownerDelegation: OwnerDelegationReceipt;
  readonly enforcementDelegation: SignedDelegation;
  readonly contentSourceDigest: string;
}

export interface OwnerSharePolicyRegistration {
  readonly registrationCid: string;
  readonly policyCid: string;
  readonly ownerDelegationCid: string;
  readonly enforcementDelegationCid: string;
  readonly ownerDid: string;
  readonly shareKeyDid: string;
  readonly enforcerDid: string;
  readonly target: { readonly origin: string; readonly nodeAudience: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact"; readonly path: string };
  readonly actions: readonly OwnerShareAction[];
  readonly contentSourceDigest: string;
  readonly registeredAt: string;
  readonly expiresAt: string;
}

export interface OwnerSharePolicyRegistrationReceipt {
  readonly registration: OwnerSharePolicyRegistration;
  readonly proof: { readonly alg: "EdDSA"; readonly kid: string; readonly signature: string };
}

function bytes(value: Uint8Array): Uint8Array { return new Uint8Array(value); }

function b64(value: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64url");
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("owner-share value is not canonical base64url");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64url"));
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function cid(bytesValue: Uint8Array): string {
  return CID.createV1(raw.code, createDigest(sha256Cid.code, sha256(bytesValue))).toString(base32.encoder);
}

function digest(bytesValue: Uint8Array): string { return b64(sha256(bytesValue)); }

function didKeyFromEd25519PublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("share key public key must be 32 bytes");
  const prefixed = new Uint8Array(34);
  prefixed.set([0xed, 0x01]);
  prefixed.set(publicKey, 2);
  return `did:key:${base58btc.encode(prefixed)}`;
}

function assertCanonical(value: string, label: string): void {
  if (value !== canonicalize(JSON.parse(value))) throw new Error(`${label} is not canonical JSON`);
}

function assertObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) throw new Error(`${label} has unknown or missing fields`);
  return record;
}

export function createDelegatedShareKey(options: { readonly extractable: boolean }): DelegatedShareKey {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = ed25519.getPublicKey(seed);
  let cleared = false;
  const key: DelegatedShareKey = {
    did: didKeyFromEd25519PublicKey(publicKey),
    publicKey: bytes(publicKey),
    extractable: options.extractable,
    ...(options.extractable ? { privateJwk: { kty: "OKP", crv: "Ed25519", x: b64(publicKey), d: b64(seed) } } : {}),
    async sign(input) {
      if (cleared) throw new Error("share key has been cleared");
      return bytes(ed25519.sign(input, seed));
    },
    clear() { seed.fill(0); cleared = true; },
  };
  return key;
}

export async function createPolicyEnforcementDelegation(input: {
  readonly ownerDelegation: OwnerDelegationReceipt;
  readonly shareKey: DelegatedShareKey;
  readonly enforcerDid: string;
  readonly policyCid: string;
  readonly shareId: string;
  readonly spaceId: string;
  readonly path: string;
  readonly actions: readonly OwnerShareAction[];
  readonly contentSourceDigest: string;
  readonly expiresAt: string;
}): Promise<SignedDelegation> {
  if (input.shareKey.did.length === 0 || input.ownerDelegation.delegationCid.length === 0) throw new Error("owner delegation and share key are required");
  const facts = {
    ownerDelegationCid: input.ownerDelegation.delegationCid,
    policyCid: input.policyCid,
    shareId: input.shareId,
    shareKeyDid: input.shareKey.did,
    enforcerDid: input.enforcerDid,
    nodeAudience: "did:web:tee.node.tinycloud.xyz",
    spaceId: input.spaceId,
    path: input.path,
    actions: [...input.actions],
    contentSourceDigest: input.contentSourceDigest,
    expiresAt: input.expiresAt,
  } satisfies Record<string, string | readonly string[]>;
  const unsigned = { type: "TinyCloudSharePolicyEnforcement", version: 2, issuerDid: input.shareKey.did, audienceDid: input.enforcerDid, facts };
  const dagCbor = canonicalize({ domain: ENFORCEMENT_DOMAIN, unsigned });
  const signature = b64(await input.shareKey.sign(new TextEncoder().encode(dagCbor)));
  return { cid: cid(new TextEncoder().encode(`${dagCbor}.${signature}`)), dagCbor: b64(new TextEncoder().encode(dagCbor)), issuerDid: input.shareKey.did, audienceDid: input.enforcerDid, facts, signature };
}

export async function canonicalOwnerSharePolicy(policy: OwnerSharePolicyV2): Promise<{ readonly bytes: Uint8Array; readonly cid: string; readonly digest: string }> {
  const text = canonicalize({ domain: POLICY_DOMAIN, policy });
  const policyBytes = new TextEncoder().encode(text);
  return { bytes: policyBytes, cid: cid(policyBytes), digest: digest(policyBytes) };
}

export function computeOwnerShareRegistrationCid(registration: Omit<OwnerSharePolicyRegistration, "registrationCid">): string {
  return cid(new TextEncoder().encode(canonicalize(registration)));
}

export function validateOwnerSharePolicyRegistration(value: unknown, expected: RegisterOwnerSharePolicyParams): OwnerSharePolicyRegistrationReceipt {
  const root = assertObject(value, ["registration", "proof"], "owner-share registration response");
  const registration = assertObject(root.registration, ["registrationCid", "policyCid", "ownerDelegationCid", "enforcementDelegationCid", "ownerDid", "shareKeyDid", "enforcerDid", "target", "resource", "actions", "contentSourceDigest", "registeredAt", "expiresAt"], "owner-share registration");
  const proof = assertObject(root.proof, ["alg", "kid", "signature"], "owner-share registration proof");
  if (proof.alg !== "EdDSA" || typeof proof.kid !== "string" || typeof proof.signature !== "string") throw new Error("owner-share registration proof is invalid");
  if (cid(expected.policy.bytes) !== expected.policy.cid) throw new Error("submitted owner-share policy bytes do not match its CID");
  if (registration.policyCid !== expected.policy.cid || registration.ownerDelegationCid !== expected.ownerDelegation.delegationCid || registration.enforcementDelegationCid !== expected.enforcementDelegation.cid || registration.contentSourceDigest !== expected.contentSourceDigest) throw new Error("owner-share registration is not bound to the submitted chain");
  if (typeof registration.registrationCid !== "string" || typeof registration.expiresAt !== "string" || typeof registration.registeredAt !== "string") throw new Error("owner-share registration timestamps are invalid");
  if (new Date(registration.expiresAt).toISOString() !== registration.expiresAt || Date.parse(registration.expiresAt) <= Date.now()) throw new Error("owner-share registration is expired or non-canonical");
  const { registrationCid: _registrationCid, ...registrationCore } = registration;
  if (computeOwnerShareRegistrationCid(registrationCore as unknown as Omit<OwnerSharePolicyRegistration, "registrationCid">) !== registration.registrationCid) throw new Error("owner-share registration CID does not match its canonical core");
  return { registration: registration as unknown as OwnerSharePolicyRegistration, proof: proof as unknown as OwnerSharePolicyRegistrationReceipt["proof"] };
}

export { MAX_CONTENT_BYTES };
