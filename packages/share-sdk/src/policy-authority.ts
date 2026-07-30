import { ed25519 } from "@noble/curves/ed25519";
import {
  canonicalize,
  computeCid,
  ed25519PublicKeyFromDidKey,
  fromBase64Url,
  type ShareEnvelopeV2,
} from "@tinycloud/share-envelope";
import {
  validateOwnerSharePolicyRegistration,
  type OwnerDelegationReceipt,
  type SignedDelegation,
} from "./owner-policy.js";
import type { SharePolicyAuthority, SharePolicyEvidence } from "./receive.js";

const ENVELOPE_DOMAIN = "xyz.tinycloud.share/envelope/v2\0";

export interface RegisteredPolicyAuthorityOptions {
  readonly nodeProof: { readonly kid: string; readonly publicKey: Uint8Array };
  readonly expectedTarget: {
    readonly origin: string;
    readonly nodeAudience: string;
    readonly enforcerDid: string;
  };
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const output = value as Record<string, unknown>;
  if (Object.keys(output).length !== keys.length || keys.some((key) => !Object.hasOwn(output, key))) throw new Error(`${label} has unknown or missing fields`);
  return output;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) throw new Error(`${label} is invalid`);
  return value;
}

function parseEnforcement(value: unknown): SignedDelegation {
  const delegation = record(value, ["cid", "dagCbor", "issuerDid", "audienceDid", "facts", "signature"], "policy enforcement delegation");
  const facts = record(delegation.facts, ["ownerDelegationCid", "policyCid", "shareId", "shareKeyDid", "enforcerDid", "nodeAudience", "spaceId", "path", "actions", "contentSourceDigest", "expiresAt"], "policy enforcement facts");
  return {
    cid: requiredString(delegation.cid, "policy enforcement CID"),
    dagCbor: requiredString(delegation.dagCbor, "policy enforcement bytes"),
    issuerDid: requiredString(delegation.issuerDid, "policy enforcement issuer"),
    audienceDid: requiredString(delegation.audienceDid, "policy enforcement audience"),
    facts: {
      ownerDelegationCid: requiredString(facts.ownerDelegationCid, "owner delegation CID"),
      policyCid: requiredString(facts.policyCid, "policy CID"),
      shareId: requiredString(facts.shareId, "share id"),
      shareKeyDid: requiredString(facts.shareKeyDid, "share key DID"),
      enforcerDid: requiredString(facts.enforcerDid, "enforcer DID"),
      nodeAudience: requiredString(facts.nodeAudience, "node audience"),
      spaceId: requiredString(facts.spaceId, "space id"),
      path: requiredString(facts.path, "resource path"),
      actions: stringArray(facts.actions, "policy actions"),
      contentSourceDigest: requiredString(facts.contentSourceDigest, "content source digest"),
      expiresAt: requiredString(facts.expiresAt, "policy expiry"),
    },
    signature: requiredString(delegation.signature, "policy enforcement signature"),
  };
}

async function verifyEnforcement(delegation: SignedDelegation): Promise<boolean> {
  try {
    const dagCbor = fromBase64Url(delegation.dagCbor);
    if (await computeCid(dagCbor) !== delegation.cid) return false;
    const signature = fromBase64Url(delegation.signature);
    return signature.length === 64 && ed25519.verify(
      signature,
      dagCbor,
      ed25519PublicKeyFromDidKey(delegation.issuerDid),
      { zip215: false },
    );
  } catch {
    return false;
  }
}

async function verifyOuterEnvelope(
  value: unknown,
  envelope: ShareEnvelopeV2,
  policyCid: string,
  expectedEnforcerDid: string,
  expectedActions: readonly string[],
): Promise<{ readonly envelopeCid: string; readonly shareCid: string } | undefined> {
  try {
    const hasDecryption = typeof value === "object" && value !== null && Object.hasOwn(value, "decryption");
    const outer = record(value, ["schema", "version", "shareId", "delegationCid", "policyCid", "target", "resource", "actions", ...(hasDecryption ? ["decryption"] : []), "contentSource", "contentSourceDigest", "expiresAt", "envelopeCid", "shareCid", "signature"], "outer envelope");
    const target = record(outer.target, ["origin", "nodeAudience", "enforcerDid", "spaceId"], "outer target");
    const signature = record(outer.signature, ["signerDid", "algorithm", "value"], "outer envelope signature");
    const envelopeCid = requiredString(outer.envelopeCid, "outer envelope CID");
    const shareCid = requiredString(outer.shareCid, "outer share CID");
    const { signature: _signature, envelopeCid: _envelopeCid, shareCid: _shareCid, ...identity } = outer;
    if (
      outer.schema !== "xyz.tinycloud.share/envelope/v2"
      || outer.version !== 2
      || outer.shareId !== envelope.shareId
      || outer.delegationCid !== envelope.delegationCid
      || outer.policyCid !== policyCid
      || target.origin !== envelope.target.origin
      || target.nodeAudience !== envelope.target.nodeAudience
      || target.enforcerDid !== expectedEnforcerDid
      || target.spaceId !== envelope.target.spaceId
      || canonicalize(outer.resource) !== canonicalize(envelope.resource)
      || canonicalize(outer.actions) !== canonicalize(expectedActions)
      || (hasDecryption
        ? envelope.decryption === undefined || canonicalize(outer.decryption) !== canonicalize(envelope.decryption)
        : envelope.decryption !== undefined)
      || canonicalize(outer.contentSource) !== canonicalize(envelope.contentSource)
      || outer.contentSourceDigest !== envelope.contentSourceDigest
      || outer.expiresAt !== envelope.expiry
      || signature.signerDid !== envelope.signature.signerDid
      || signature.algorithm !== "Ed25519"
    ) return undefined;
    if (envelopeCid !== await computeCid(new TextEncoder().encode(canonicalize(identity)))) return undefined;
    if (shareCid !== await computeCid(new TextEncoder().encode(canonicalize({ version: 2, shareId: envelope.shareId, policyCid, envelopeCid })))) return undefined;
    const unsigned = { ...identity, envelopeCid, shareCid };
    const signatureBytes = fromBase64Url(requiredString(signature.value, "outer signature"));
    if (signatureBytes.length !== 64 || !ed25519.verify(
      signatureBytes,
      new TextEncoder().encode(`${ENVELOPE_DOMAIN}${canonicalize(unsigned)}`),
      ed25519PublicKeyFromDidKey(envelope.signature.signerDid),
      { zip215: false },
    )) return undefined;
    return { envelopeCid, shareCid };
  } catch {
    return undefined;
  }
}

/**
 * Build a policy authority from an enrolled node receipt key. The encrypted
 * envelope carries the receipt as evidence, but only the separately pinned
 * key can make that evidence authoritative.
 */
export function createRegisteredPolicyAuthority(options: RegisteredPolicyAuthorityOptions): SharePolicyAuthority {
  const proofKey = options.nodeProof.publicKey.slice();
  return {
    async resolve({ policyCid, envelope }): Promise<SharePolicyEvidence | undefined> {
      try {
        if (envelope.authorizationTarget.kind !== "policy" || envelope.authorizationTarget.policyCid !== policyCid) return undefined;
        const ownerAuthority = envelope.ownerAuthority as typeof envelope.ownerAuthority & {
          readonly registrationReceipt?: unknown;
        };
        if (ownerAuthority?.registrationReceipt === undefined) return undefined;
        const enforcement = parseEnforcement(ownerAuthority.enforcementDelegation);
        if (!await verifyEnforcement(enforcement)) return undefined;
        const policyBytes = fromBase64Url(envelope.authorizationTarget.policyBytes);
        const ownerDelegation: OwnerDelegationReceipt = {
          delegationCid: envelope.delegationCid,
          signedDagCbor: new Uint8Array(),
          delegation: {
            delegateDID: envelope.signature.signerDid,
            spaceId: envelope.target.spaceId,
            path: envelope.resource.path,
            actions: envelope.actions,
            expiry: new Date(envelope.expiry),
          },
        };
        const receipt = validateOwnerSharePolicyRegistration(ownerAuthority.registrationReceipt, {
          policy: { bytes: policyBytes, cid: policyCid, proof: "" },
          ownerDelegation,
          enforcementDelegation: enforcement,
          contentSourceDigest: envelope.contentSourceDigest,
          nodeProof: { kid: options.nodeProof.kid, publicKey: proofKey },
        });
        const registration = receipt.registration;
        const outer = await verifyOuterEnvelope(ownerAuthority.outerEnvelope, envelope, policyCid, options.expectedTarget.enforcerDid, registration.actions);
        if (
          outer === undefined
          || ownerAuthority.registrationCid !== registration.registrationCid
          || ownerAuthority.envelopeCid !== outer.envelopeCid
          || ownerAuthority.shareCid !== outer.shareCid
          || envelope.authorityMaterialHandle !== registration.registrationCid
          || envelope.signature.signerDid !== registration.shareKeyDid
          || registration.target.origin !== options.expectedTarget.origin
          || registration.target.nodeAudience !== options.expectedTarget.nodeAudience
          || registration.enforcerDid !== options.expectedTarget.enforcerDid
          || enforcement.issuerDid !== registration.shareKeyDid
          || enforcement.audienceDid !== registration.enforcerDid
        ) return undefined;
        return {
          policyCid: registration.policyCid,
          signerDid: registration.shareKeyDid,
          registrationCid: registration.registrationCid,
          shareId: registration.shareId,
          recipientMatcher: registration.recipientMatcher,
          target: registration.target,
          resource: registration.resource,
          actions: registration.actions,
          contentSource: registration.contentSource,
          contentSourceDigest: registration.contentSourceDigest,
          delegationCid: registration.ownerDelegationCid,
          authorityMaterialHandle: registration.registrationCid,
          authorityMaterialDigest: envelope.authorityMaterialDigest,
          expiresAt: registration.expiresAt,
        };
      } catch {
        return undefined;
      }
    },
  };
}
