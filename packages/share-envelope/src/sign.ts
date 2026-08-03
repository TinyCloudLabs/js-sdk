import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import { fromBase64Url, toBase64Url, utf8Bytes } from "./bytes.js";
import { computeCid } from "./cid.js";
import { didKeyFromEd25519PublicKey, ed25519PublicKeyFromDidKey } from "./didkey.js";
import { canonicalize } from "./jcs.js";
import { verifyCompactUcanAuthorization } from "./compact-ucan.js";
import {
  shareEnvelopeSchema,
  shareEnvelopeV2Schema,
  shareEnvelopeV3Schema,
  unsignedShareEnvelopeSchema,
  unsignedShareEnvelopeV2Schema,
  unsignedShareEnvelopeV3Schema,
  type ShareEnvelope,
  type ShareEnvelopeV2,
  type UnsignedShareEnvelope,
  type UnsignedShareEnvelopeV2,
  type ShareEnvelopeV3,
  type UnsignedShareEnvelopeV3,
} from "./schema.js";

/**
 * Ed25519 verification mode: strict RFC 8032, NOT ZIP-215. `zip215: false`
 * makes @noble/curves reject non-canonical point encodings (y >= p) that the
 * looser ZIP-215 rules accept, so this JS verifier and a strict Rust verifier
 * (e.g. ed25519-dalek `verify_strict`) agree on exactly the same signature
 * set. Chosen deliberately: interop determinism over batch-verification
 * compatibility.
 */
const ED25519_VERIFY_OPTS = { zip215: false } as const;

/** The one canonical envelope signing domain shared by runtime and vectors. */
export const ENVELOPE_SIGNATURE_DOMAIN = "xyz.tinycloud.share/envelope/v1\0";
export const ENVELOPE_V2_SIGNATURE_DOMAIN = "xyz.tinycloud.share/envelope/v2\0";
export const ENVELOPE_V3_SIGNATURE_DOMAIN = "xyz.tinycloud.share/envelope/v3\0";
const POLICY_V1_SIGNATURE_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
const CONTENT_SOURCE_V1_DOMAIN = "xyz.tinycloud.policy/ContentSource/v1\0";
const POLICY_CAPABILITY_V1_DOMAIN = "xyz.tinycloud.policy/PolicyCapability/v1\0";
const NATIVE_PROJECTION_V1_DOMAIN = "xyz.tinycloud.policy/NativeProjection/v1\0";
const ATTESTED_ENFORCER_V2_DOMAIN = "xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0";

/** Domain-separated JCS bytes of every envelope field except `signature`. */
function signingBytes(unsigned: UnsignedShareEnvelope): Uint8Array {
  const domain = utf8Bytes(ENVELOPE_SIGNATURE_DOMAIN);
  const body = utf8Bytes(canonicalize(unsigned));
  const bytes = new Uint8Array(domain.length + body.length);
  bytes.set(domain);
  bytes.set(body, domain.length);
  return bytes;
}

function signingBytesV2(unsigned: UnsignedShareEnvelopeV2): Uint8Array {
  const domain = utf8Bytes(ENVELOPE_V2_SIGNATURE_DOMAIN);
  const body = utf8Bytes(canonicalize(unsigned));
  const bytes = new Uint8Array(domain.length + body.length);
  bytes.set(domain);
  bytes.set(body, domain.length);
  return bytes;
}

function signingBytesV3(unsigned: UnsignedShareEnvelopeV3): Uint8Array {
  const domain = utf8Bytes(ENVELOPE_V3_SIGNATURE_DOMAIN);
  const body = utf8Bytes(canonicalize(unsigned));
  const bytes = new Uint8Array(domain.length + body.length);
  bytes.set(domain);
  bytes.set(body, domain.length);
  return bytes;
}

/**
 * Sign an envelope body with an ed25519 private key (32-byte seed). The
 * signature covers the domain-separated RFC 8785 canonical JSON of all other fields —
 * including `authorizationTarget.kind` and `target.origin` (blueprint §2.1).
 * Throws if the body does not validate against the strict schema.
 */
export function signEnvelope(
  envelopeWithoutSig: UnsignedShareEnvelope,
  ed25519PrivKey: Uint8Array,
): ShareEnvelope {
  const unsigned = unsignedShareEnvelopeSchema.parse(envelopeWithoutSig);
  const publicKey = ed25519.getPublicKey(ed25519PrivKey);
  const signature = ed25519.sign(signingBytes(unsigned), ed25519PrivKey);
  return {
    ...unsigned,
    signature: {
      signerDid: didKeyFromEd25519PublicKey(publicKey),
      algorithm: "Ed25519",
      value: toBase64Url(signature),
    },
  };
}

export function signEnvelopeV2(envelopeWithoutSig: UnsignedShareEnvelopeV2, ed25519PrivKey: Uint8Array): ShareEnvelopeV2 {
  const unsigned = unsignedShareEnvelopeV2Schema.parse(envelopeWithoutSig);
  const publicKey = ed25519.getPublicKey(ed25519PrivKey);
  return {
    ...unsigned,
    signature: {
      signerDid: didKeyFromEd25519PublicKey(publicKey),
      algorithm: "Ed25519",
      value: toBase64Url(ed25519.sign(signingBytesV2(unsigned), ed25519PrivKey)),
    },
  };
}

/** Sign a strict v3 envelope. v3 is intentionally not accepted by v1/v2 helpers. */
export function signEnvelopeV3(envelopeWithoutSig: UnsignedShareEnvelopeV3, ed25519PrivKey: Uint8Array): ShareEnvelopeV3 {
  const unsigned = unsignedShareEnvelopeV3Schema.parse(envelopeWithoutSig);
  const publicKey = ed25519.getPublicKey(ed25519PrivKey);
  return {
    ...unsigned,
    signature: {
      signerDid: didKeyFromEd25519PublicKey(publicKey),
      algorithm: "Ed25519",
      value: toBase64Url(ed25519.sign(sha256(signingBytesV3(unsigned)), ed25519PrivKey)),
    },
  };
}

export interface VerifyEnvelopeOptions {
  /**
   * The did:key the caller ALREADY trusts to be the sender. REQUIRED:
   * `signature.signerDid` is self-asserted by whoever built the envelope, so
   * verifying against it alone proves nothing — an attacker signs their own
   * "Adam" envelope with their own key and it self-verifies. In later stages
   * the expected signer is the delegation chain's issuer DID; for now the
   * caller supplies it out-of-band.
   */
  expectedSignerDid: string;
}

/**
 * Signature-only check: strict-parse, recompute the JCS signing bytes, and
 * check the ed25519 signature against the key in `signature.signerDid`.
 *
 * WARNING: this only proves the envelope is internally consistent with its
 * OWN self-asserted signer. It binds no trust — use `verifyEnvelope` with an
 * `expectedSignerDid` unless you are doing the binding yourself.
 */
export function verifyEnvelopeSignatureOnly(envelope: ShareEnvelope): boolean {
  const parsed = shareEnvelopeSchema.parse(envelope);
  const { signature, ...unsigned } = parsed;
  const publicKey = ed25519PublicKeyFromDidKey(signature.signerDid);
  return ed25519.verify(
    fromBase64Url(signature.value),
    signingBytes(unsigned),
    publicKey,
    ED25519_VERIFY_OPTS,
  );
}

/**
 * Verify a signed envelope against an EXPECTED signer:
 *
 * 1. strict schema parse (throws on malformed input),
 * 2. `signature.signerDid` must equal `options.expectedSignerDid`,
 * 3. the ed25519 signature must verify (strict RFC 8032) over the domain-separated JCS bytes,
 * 4. for `authorizationTarget.kind === "policy"`, the decoded `policyBytes`
 *    must hash to `policyCid` (CIDv1/raw/sha2-256).
 *
 * Returns false for any trust or integrity failure.
 */
export async function verifyEnvelope(
  envelope: ShareEnvelope,
  options: VerifyEnvelopeOptions,
): Promise<boolean> {
  const parsed = shareEnvelopeSchema.parse(envelope);
  if (parsed.signature.signerDid !== options.expectedSignerDid) return false;
  if (!verifyEnvelopeSignatureOnly(parsed)) return false;
  if (parsed.authorizationTarget.kind === "policy") {
    const policyBytes = fromBase64Url(parsed.authorizationTarget.policyBytes);
    if ((await computeCid(policyBytes)) !== parsed.authorizationTarget.policyCid) {
      return false;
    }
  }
  return true;
}

export function verifyEnvelopeV2SignatureOnly(envelope: ShareEnvelopeV2): boolean {
  const parsed = shareEnvelopeV2Schema.parse(envelope);
  const { signature, ...unsigned } = parsed;
  return ed25519.verify(fromBase64Url(signature.value), signingBytesV2(unsigned), ed25519PublicKeyFromDidKey(signature.signerDid), ED25519_VERIFY_OPTS);
}

export async function verifyEnvelopeV2(envelope: ShareEnvelopeV2, options: VerifyEnvelopeOptions): Promise<boolean> {
  const parsed = shareEnvelopeV2Schema.parse(envelope);
  if (parsed.signature.signerDid !== options.expectedSignerDid || !verifyEnvelopeV2SignatureOnly(parsed)) return false;
  if (parsed.authorizationTarget.kind === "policy") return (await computeCid(fromBase64Url(parsed.authorizationTarget.policyBytes))) === parsed.authorizationTarget.policyCid;
  return true;
}

export function verifyEnvelopeV3SignatureOnly(envelope: ShareEnvelopeV3): boolean {
  const parsed = shareEnvelopeV3Schema.parse(envelope);
  const { signature, ...unsigned } = parsed;
  return ed25519.verify(fromBase64Url(signature.value), sha256(signingBytesV3(unsigned)), ed25519PublicKeyFromDidKey(signature.signerDid), ED25519_VERIFY_OPTS);
}

export async function verifyEnvelopeV3(envelope: ShareEnvelopeV3, options: VerifyEnvelopeOptions): Promise<boolean> {
  const parsed = shareEnvelopeV3Schema.parse(envelope);
  if (parsed.signature.signerDid !== options.expectedSignerDid || parsed.signature.signerDid !== parsed.policy.ownerDid || !verifyEnvelopeV3SignatureOnly(parsed)) return false;
  const { policy } = parsed;
  const unsignedPolicy = { ...policy } as Record<string, unknown>;
  delete unsignedPolicy.policyId;
  delete unsignedPolicy.signature;
  const policyDigest = sha256(new TextEncoder().encode(`${POLICY_V1_SIGNATURE_DOMAIN}${canonicalize(unsignedPolicy)}`));
  const policySignature = policy.signature;
  if (policySignature.suite !== "Ed25519" || policySignature.signerDid !== policy.ownerDid) return false;
  let policyPublicKey: Uint8Array;
  let policySignatureBytes: Uint8Array;
  try {
    policyPublicKey = ed25519PublicKeyFromDidKey(policy.ownerDid);
    policySignatureBytes = fromBase64Url(policySignature.value);
  } catch {
    return false;
  }
  if (policySignatureBytes.length !== 64 || !ed25519.verify(policySignatureBytes, policyDigest, policyPublicKey, ED25519_VERIFY_OPTS)) return false;
  const policyIdDigest = sha256(new TextEncoder().encode(`${POLICY_V1_SIGNATURE_DOMAIN}${canonicalize(unsignedPolicy)}`));
  if (policy.policyId !== `pol_${base32Lower(policyIdDigest)}`) return false;
  const policyBytes = new TextEncoder().encode(canonicalize(policy));
  if ((await computeCid(policyBytes)) !== parsed.policyCid) return false;
  const sourceDigest = sha256(new TextEncoder().encode(`${CONTENT_SOURCE_V1_DOMAIN}${canonicalize(policy.contentSource)}`));
  if (hex(sourceDigest) !== parsed.contentSourceDigestHex) return false;
  const sortedCapabilities = [...policy.capabilityCeiling].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  const capabilityCeilingHashHex = hex(sha256(new TextEncoder().encode(`${POLICY_CAPABILITY_V1_DOMAIN}${canonicalize(sortedCapabilities)}`)));
  const nativeProjection = sortedCapabilities.map((capability) => capability.kind === "encryption"
    ? { service: "tinycloud.encryption", space: capability.resource, path: capability.resource, actions: [capability.action] }
    : { service: "tinycloud.kv", space: capability.resource.slice("tinycloud://".length).split("/")[0], path: capability.resource.split("/kv/")[1], actions: [...capability.actions], caveat: { type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource } })
    .sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  const nativeProjectionHashHex = hex(sha256(new TextEncoder().encode(`${NATIVE_PROJECTION_V1_DOMAIN}${canonicalize(nativeProjection)}`)));
  const expectedAttenuation = Object.fromEntries(sortedCapabilities.map((capability) => capability.kind === "encryption"
    ? [capability.resource, { [capability.action]: [{}] }]
    : [capability.resource, Object.fromEntries(capability.actions.map((action) => [action, [{ kind: capability.selector, type: "xyz.tinycloud.resource/selector", value: capability.resource }]]))]));
  const kv = policy.capabilityCeiling.find((capability) => capability.kind === "kv");
  const expectedKvActions = parsed.actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]);
  const resource = /^tinycloud:\/\/([^/]+)\/kv\/(.+)$/.exec(parsed.contentSource.kvResource);
  if (parsed.shareId !== parsed.contentSource.shareId || resource === null || resource[1] !== parsed.target.spaceId || resource[2] !== parsed.resource.path.replace(/\/$/, "") || parsed.resource.kind !== parsed.contentSource.selector || kv?.kind !== "kv" || expectedKvActions.some((action) => !kv.actions.includes(action as never)) || parsed.encryptionNetwork !== parsed.contentSource.encryptionNetwork || parsed.contentSource.keyVersion <= 0 || (policy.expiresAt !== undefined && Date.parse(parsed.expiry) > Date.parse(policy.expiresAt))) return false;
  const binding = parsed.attestedEnforcerBinding;
  const { signature: bindingSignature, ...unsignedBinding } = binding;
  const expectedBindingDigestHex = hex(sha256(new TextEncoder().encode(canonicalize({ enforcerDid: binding.enforcerDid, nodeAudience: binding.nodeAudience }))));
  if (binding.enforcerDid !== parsed.target.nodeAudience || binding.nodeAudience !== parsed.target.nodeAudience || binding.attestationBindingDigestHex !== expectedBindingDigestHex || bindingSignature.signerDid !== binding.enforcerDid || bindingSignature.suite !== "Ed25519" || Date.parse(binding.issuedAt) > Date.now() || Date.parse(binding.expiresAt) <= Date.now() || Date.parse(binding.expiresAt) < Date.parse(parsed.expiry)) return false;
  try {
    const digest = sha256(new TextEncoder().encode(`${ATTESTED_ENFORCER_V2_DOMAIN}${canonicalize(unsignedBinding)}`));
    if (!ed25519.verify(fromBase64Url(bindingSignature.value), digest, ed25519PublicKeyFromDidKey(binding.enforcerDid), ED25519_VERIFY_OPTS)) return false;
  } catch {
    return false;
  }
  if (parsed.policyRoot.role !== "policy-authority" || parsed.enforcementRoot.role !== "policy-enforcement" || parsed.policyRoot.cid === parsed.enforcementRoot.cid) return false;
  try {
    const policyRoot = verifyCompactUcanAuthorization(parsed.policyRoot.authorization, parsed.policyRoot.cid);
    const enforcementRoot = verifyCompactUcanAuthorization(parsed.enforcementRoot.authorization, parsed.enforcementRoot.cid);
    const policyFact = policyRoot.payload.fct[0];
    const enforcementFact = enforcementRoot.payload.fct[0];
    const common = ["ownerDid", "policyId", "policyDigestHex", "policyCid", "contentSourceDigestHex", "capabilityCeilingHashHex", "nativeProjectionHashHex", "nodeAudience"];
    const policyKeys = [...common, "role", "mode"];
    const enforcementKeys = [...policyKeys, "enforcerDid"];
    if (Object.keys(policyFact).length !== policyKeys.length || policyKeys.some((key) => !(key in policyFact)) || Object.keys(enforcementFact).length !== enforcementKeys.length || enforcementKeys.some((key) => !(key in enforcementFact)) || policyRoot.payload.prf.length !== 0 || enforcementRoot.payload.prf.length !== 0 || policyRoot.payload.iss.split("#", 1)[0] !== policy.ownerDid || enforcementRoot.payload.iss.split("#", 1)[0] !== policy.ownerDid || policyRoot.payload.nbf !== enforcementRoot.payload.nbf || policyRoot.payload.exp !== enforcementRoot.payload.exp || canonicalize(policyRoot.payload.att) !== canonicalize(expectedAttenuation) || canonicalize(enforcementRoot.payload.att) !== canonicalize(expectedAttenuation) || policyFact.role !== "policy-authority" || policyFact.mode !== "policy-source" || "enforcerDid" in policyFact || enforcementFact.role !== "policy-enforcement" || enforcementFact.mode !== "conditional-mint" || policyRoot.payload.aud !== `did:tinycloud:policy:${hex(policyIdDigest)}` || enforcementRoot.payload.aud !== parsed.target.nodeAudience || enforcementFact.enforcerDid !== parsed.target.nodeAudience || common.some((key) => policyFact[key] !== enforcementFact[key]) || policyFact.ownerDid !== policy.ownerDid || policyFact.policyId !== policy.policyId || policyFact.policyDigestHex !== hex(policyIdDigest) || policyFact.policyCid !== parsed.policyCid || policyFact.contentSourceDigestHex !== parsed.contentSourceDigestHex || policyFact.capabilityCeilingHashHex !== capabilityCeilingHashHex || policyFact.nativeProjectionHashHex !== nativeProjectionHashHex || policyFact.nodeAudience !== parsed.target.nodeAudience || policyRoot.payload.exp * 1000 < Date.parse(parsed.expiry)) return false;
  } catch {
    return false;
  }
  return true;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base32Lower(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
