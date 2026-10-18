import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import {
  canonicalize, computeCid, ed25519PublicKeyFromDidKey, fromBase64Url, shareEnvelopeV3Schema, verifyCompactUcanAuthorization, verifyEnvelopeV3SignatureOnly,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";

/**
 * Policy/v3 envelope verification at an explicit time. Security-sensitive.
 *
 * A line-for-line port of share-envelope `verifyEnvelopeV3` (`sign.ts`) whose
 * only change is that the enforcer-binding window is judged at `now` instead
 * of `Date.now()`, so a genuine but expired share can be reported as Expired
 * rather than invalid (design C4). It lives here, in the share-index entry,
 * so the package root (and the web-sdk bundle) does not change; keep it in
 * step with `verifyEnvelopeV3`. `test/share-index/policy-v3-parity.test.ts`
 * runs both on a frozen clock over a genuine envelope and single-field
 * tampers. Delete this copy once share-envelope's `verifyEnvelopeV3` takes a
 * `now` option.
 */

const ED25519_VERIFY_OPTS = { zip215: false } as const;
const POLICY_V1_SIGNATURE_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
const POLICY_V2_SIGNATURE_DOMAIN = "xyz.tinycloud.policy/policy/v2\0";
const CONTENT_SOURCE_V1_DOMAIN = "xyz.tinycloud.policy/ContentSource/v1\0";
const POLICY_CAPABILITY_V1_DOMAIN = "xyz.tinycloud.policy/PolicyCapability/v1\0";
const NATIVE_PROJECTION_V1_DOMAIN = "xyz.tinycloud.policy/NativeProjection/v1\0";
const ATTESTED_ENFORCER_V2_DOMAIN = "xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0";

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

export async function verifyEnvelopeV3At(envelope: ShareEnvelopeV3, expectedSignerDid: string, now: number): Promise<boolean> {
  const parsed = shareEnvelopeV3Schema.parse(envelope);
  if (parsed.signature.signerDid !== expectedSignerDid || parsed.signature.signerDid !== parsed.policy.ownerDid || !verifyEnvelopeV3SignatureOnly(parsed)) return false;
  const { policy } = parsed;
  const unsignedPolicy = { ...policy } as Record<string, unknown>;
  delete unsignedPolicy.policyId;
  delete unsignedPolicy.signature;
  const policySignatureDomain = policy.schema === "xyz.tinycloud.policy/policy/v2"
    ? POLICY_V2_SIGNATURE_DOMAIN
    : POLICY_V1_SIGNATURE_DOMAIN;
  const policyDigest = sha256(new TextEncoder().encode(`${policySignatureDomain}${canonicalize(unsignedPolicy)}`));
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
  const policyIdDigest = policyDigest;
  if (policy.policyId !== `pol_${base32Lower(policyIdDigest)}`) return false;
  const policyBytes = new TextEncoder().encode(canonicalize(policy));
  if ((await computeCid(policyBytes)) !== parsed.policyCid) return false;
  const sourceDigest = sha256(new TextEncoder().encode(`${CONTENT_SOURCE_V1_DOMAIN}${canonicalize(policy.contentSource)}`));
  if (hex(sourceDigest) !== parsed.contentSourceDigestHex) return false;
  const sortedCapabilities = [...policy.capabilityCeiling].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  const capabilityCeilingHashHex = hex(sha256(new TextEncoder().encode(`${POLICY_CAPABILITY_V1_DOMAIN}${canonicalize(sortedCapabilities)}`)));
  const nativeProjection = sortedCapabilities.map((capability) => capability.kind === "encryption"
    ? { service: "tinycloud.encryption", space: capability.resource, path: capability.resource, actions: [capability.action] }
    : { service: "tinycloud.kv", space: capability.resource.slice(0, capability.resource.indexOf("/kv/")), path: capability.resource.split("/kv/")[1], actions: [...capability.actions], caveat: { type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource } })
    .sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  const nativeProjectionHashHex = hex(sha256(new TextEncoder().encode(`${NATIVE_PROJECTION_V1_DOMAIN}${canonicalize(nativeProjection)}`)));
  const expectedAttenuation = Object.fromEntries(sortedCapabilities.map((capability) => capability.kind === "encryption"
    ? [capability.resource, { [capability.action]: [{}] }]
    : [capability.resource, Object.fromEntries(capability.actions.map((action) => [action, [{ kind: capability.selector, type: "xyz.tinycloud.resource/selector", value: capability.resource }]]))]));
  const kv = policy.capabilityCeiling.find((capability) => capability.kind === "kv");
  const expectedKvActions = parsed.actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]);
  const marker = parsed.contentSource.kvResource.indexOf("/kv/");
  const resourceSpace = marker < 1 ? "" : parsed.contentSource.kvResource.slice(0, marker);
  const resourcePath = marker < 1 ? "" : parsed.contentSource.kvResource.slice(marker + 4);
  if (parsed.shareId !== parsed.contentSource.shareId || resourceSpace !== parsed.target.spaceId || resourcePath !== parsed.resource.path.replace(/\/$/, "") || parsed.resource.kind !== parsed.contentSource.selector || kv?.kind !== "kv" || expectedKvActions.some((action) => !kv.actions.includes(action as never)) || parsed.encryptionNetwork !== parsed.contentSource.encryptionNetwork || parsed.contentSource.keyVersion <= 0 || (policy.expiresAt !== undefined && Date.parse(parsed.expiry) > Date.parse(policy.expiresAt))) return false;
  const binding = parsed.attestedEnforcerBinding;
  const { signature: bindingSignature, ...unsignedBinding } = binding;
  const expectedBindingDigestHex = hex(sha256(new TextEncoder().encode(canonicalize({ enforcerDid: binding.enforcerDid, nodeAudience: binding.nodeAudience }))));
  if (binding.nodeAudience !== parsed.target.nodeAudience || binding.attestationBindingDigestHex !== expectedBindingDigestHex || bindingSignature.signerDid !== binding.nodeAudience || bindingSignature.suite !== "Ed25519" || Date.parse(binding.issuedAt) > now || Date.parse(binding.expiresAt) <= now || Date.parse(binding.expiresAt) < Date.parse(parsed.expiry)) return false;
  try {
    const digest = sha256(new TextEncoder().encode(`${ATTESTED_ENFORCER_V2_DOMAIN}${canonicalize(unsignedBinding)}`));
    if (!ed25519.verify(fromBase64Url(bindingSignature.value), digest, ed25519PublicKeyFromDidKey(binding.nodeAudience), ED25519_VERIFY_OPTS)) return false;
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
    if (Object.keys(policyFact).length !== policyKeys.length || policyKeys.some((key) => !(key in policyFact)) || Object.keys(enforcementFact).length !== enforcementKeys.length || enforcementKeys.some((key) => !(key in enforcementFact)) || policyRoot.payload.prf.length !== 0 || enforcementRoot.payload.prf.length !== 0 || policyRoot.payload.iss.split("#", 1)[0] !== policy.ownerDid || enforcementRoot.payload.iss.split("#", 1)[0] !== policy.ownerDid || policyRoot.payload.nbf !== enforcementRoot.payload.nbf || policyRoot.payload.exp !== enforcementRoot.payload.exp || canonicalize(policyRoot.payload.att) !== canonicalize(expectedAttenuation) || canonicalize(enforcementRoot.payload.att) !== canonicalize(expectedAttenuation) || policyFact.role !== "policy-authority" || policyFact.mode !== "policy-source" || "enforcerDid" in policyFact || enforcementFact.role !== "policy-enforcement" || enforcementFact.mode !== "conditional-mint" || policyRoot.payload.aud !== `did:tinycloud:policy:${hex(policyIdDigest)}` || enforcementRoot.payload.aud !== binding.enforcerDid || enforcementFact.enforcerDid !== binding.enforcerDid || common.some((key) => policyFact[key] !== enforcementFact[key]) || policyFact.ownerDid !== policy.ownerDid || policyFact.policyId !== policy.policyId || policyFact.policyDigestHex !== hex(policyIdDigest) || policyFact.policyCid !== parsed.policyCid || policyFact.contentSourceDigestHex !== parsed.contentSourceDigestHex || policyFact.capabilityCeilingHashHex !== capabilityCeilingHashHex || policyFact.nativeProjectionHashHex !== nativeProjectionHashHex || policyFact.nodeAudience !== binding.nodeAudience || policyRoot.payload.exp * 1000 < Date.parse(parsed.expiry)) return false;
  } catch {
    return false;
  }
  return true;
}
