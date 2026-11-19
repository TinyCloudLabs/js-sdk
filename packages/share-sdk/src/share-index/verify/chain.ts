import { blake3 } from "@noble/hashes/blake3";
import { computeCid, fromBase64Url, shareEnvelopeV3Schema } from "@tinycloud/share-envelope";
import { verifyEnvelopeV3At } from "./policy-v3.js";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { openDeliveryEnvelope, type StoredShareRecord } from "../delivery.js";
import { checkRegistrationReceipt, type CheckedRegistration } from "./registration.js";
import { canonicalAddressSpelling } from "../agent-record.js";
import { REGISTERED_AT_SKEW_MS, type ShareProofState } from "../schema.js";
import type { Attenuation } from "./attenuation.js";
import { verifyPolicyEnforcementDelegation } from "./enforcement-delegation.js";
import { NOT_BEFORE_SKEW_MS, verifyOwnerSessionDelegation, type SiweCacaoParser } from "./session.js";
import { parseSignedUcan, principalOf } from "./ucan.js";

/**
 * CID ownership by proof (design C §5 check 7, C1–C4). Everything is checked
 * from the signed bytes the record carries; nothing is fetched.
 *
 * - `proven`: the full chain verifies to the account owner and the leaf
 *   issuer (the policy owner for Policy/v3) is `hdr.agentDid`.
 * - `chained`: the full chain verifies to the account owner through another key.
 * - `unproven`: the leaf verifies but the owner→session CACAO is absent.
 * - `expired` is reported next to the state: a chain that verifies but has
 *   expired is admitted as Expired, not rejected.
 * - anything else: `{ ok: false }` (reason `proof`).
 *
 * Supported chains: native bearer links (`proofs.link` + `proofs.session`),
 * Policy/v3 addressed shares (the envelope opened from
 * `deliveryMaterial.sealedEnvelope`, bound to `shareCid`, + `proofs.session`)
 * and Policy/v2 owner-policy shares (`proofs.ownerPolicy`, `ownerDelegation`,
 * `enforcementDelegation`, optional `registration`).
 *
 * What revocation achieves today (local node, C5): the owner wallet's generic
 * `/revoke` of a verified v3 root CID ends that share at once, open recipient
 * sessions included (403 `root-revoked`); only the JSON root-revocation route
 * refuses the owner (403 `root-revocation-issuer-invalid`). Revoking the
 * verified session CACAO kills the session's bearer links and new v3 claims
 * at once, but an already-open v3 recipient session keeps reading for its
 * lifetime (3,598 s observed) until the node liveness check (N3, test B-1).
 * Migrated records are verified with no agent binding, so they are never
 * `proven`.
 */
export type ChainVerdict =
  | {
    readonly ok: true;
    readonly state: ShareProofState;
    readonly expired: boolean;
    readonly claims: readonly string[];
    /**
     * Where `registeredAt` may lie, from signed times in the chain (epoch ms):
     * a signed issuance time ± {@link REGISTERED_AT_SKEW_MS} when the chain
     * has one (link `nbf`, the v3 binding's `issuedAt`, the node's v2
     * `registeredAt`); otherwise the session's signed `Issued At` as the
     * earliest and the leaf's expiry as the latest.
     */
    readonly issued: { readonly earliest?: number; readonly latest?: number };
  }
  | { readonly ok: false; readonly detail: string };

/** The node registration key for a node audience, from the share public config. */
export interface ShareRegistrationKey {
  readonly kid: string;
  /** Raw 32-byte Ed25519 key, or its 34-byte did:key multicodec form. */
  readonly publicKey: Uint8Array;
}

export interface ChainContext {
  readonly accountOwnerDid: string;
  /** `hdr.agentDid`, already bound to the path by `derive(agentDid) == agentId`. */
  readonly agentDid: string;
  readonly now: Date;
  readonly parseSiweCacao: SiweCacaoParser;
  /** Registration key by `target.nodeAudience`; absent ⇒ `registrationCid` is not claimed. */
  readonly registrationKey?: (nodeAudience: string) => ShareRegistrationKey | undefined;
}

class ProofFailure extends Error {}

function fail(detail: string): never {
  throw new ProofFailure(detail);
}

/** CID (raw, blake3) of a base64url DAG-CBOR CACAO's exact bytes. */
function cacaoCid(authorization: string): string {
  return CID.createV1(0x55, createDigest(0x1e, blake3(fromBase64Url(authorization.replace(/=+$/, ""))))).toString();
}

function kvResource(record: StoredShareRecord): string {
  return `${record.target.spaceId}/kv/${record.resource.path}`;
}

function sameAttenuationResources(attenuation: Attenuation, resources: readonly string[]): boolean {
  const keys = Object.keys(attenuation).map(canonicalAddressSpelling).sort();
  const expected = resources.map(canonicalAddressSpelling).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function around(signedMs: number): { readonly earliest: number; readonly latest: number } {
  return { earliest: signedMs - REGISTERED_AT_SKEW_MS, latest: signedMs + REGISTERED_AT_SKEW_MS };
}

async function bearerChain(record: StoredShareRecord, link: string, context: ChainContext): Promise<ChainVerdict> {
  if (record.enforcementDelegationCid === undefined) fail("bearer record names no link delegation");
  const leaf = parseSignedUcan(link, record.enforcementDelegationCid);
  const resource = kvResource(record);
  if (!sameAttenuationResources(leaf.attenuation, [resource]) || !Object.keys(Object.values(leaf.attenuation)[0]!).every((ability) => record.actions.includes(ability as never))) fail("link delegation is not for the record's resource");
  if (leaf.notBefore !== undefined && leaf.notBefore * 1000 > context.now.getTime() + NOT_BEFORE_SKEW_MS) fail("link delegation is not yet valid");
  if (leaf.proofs.length !== 1) fail("link delegation must have exactly one parent");
  const leafExpired = leaf.expiresAt * 1000 <= context.now.getTime();
  const claims = [leaf.cid];
  // WASM-issued link delegations carry no `nbf`; then the session's signed `Issued At` and the link's expiry bound it.
  const signedIssue = leaf.notBefore === undefined ? undefined : around(leaf.notBefore * 1000);
  const session = record.proofs?.session;
  if (session === undefined) return { ok: true, state: "unproven", expired: leafExpired, claims, issued: signedIssue ?? { latest: leaf.expiresAt * 1000 } };
  // prf ∋ parent CID: the CACAO must be exactly the leaf's parent.
  const parent = await verifyOwnerSessionDelegation({ authorization: session, expectedCid: leaf.proofs[0]!, accountOwnerDid: context.accountOwnerDid, childIssuer: leaf.issuer, childAttenuation: leaf.attenuation, now: context.now, parse: context.parseSiweCacao });
  const issued = signedIssue ?? { ...(parent.issuedAt === undefined ? {} : { earliest: parent.issuedAt - REGISTERED_AT_SKEW_MS }), latest: leaf.expiresAt * 1000 };
  return { ok: true, state: leaf.issuer === principalOf(context.agentDid) ? "proven" : "chained", expired: leafExpired || parent.time === "expired", claims, issued };
}

async function policyV3Chain(record: StoredShareRecord, envelopeValue: unknown, context: ChainContext): Promise<ChainVerdict> {
  const parsed = shareEnvelopeV3Schema.safeParse(envelopeValue);
  if (!parsed.success) fail("Policy/v3 envelope is malformed");
  const envelope = parsed.data;
  const ownerDid = envelope.policy.ownerDid;
  const binding = envelope.attestedEnforcerBinding;
  // Validity apart from time, judged inside the binding's own window; expiry is reported below.
  if (!await verifyEnvelopeV3At(envelope, ownerDid, Date.parse(binding.issuedAt))) fail("Policy/v3 chain does not verify");
  if (envelope.policyCid !== record.policyCid || envelope.policyRoot.cid !== record.ownerDelegationCid || envelope.enforcementRoot.cid !== record.enforcementDelegationCid || envelope.shareId !== record.shareId
    || canonicalAddressSpelling(envelope.target.spaceId) !== canonicalAddressSpelling(record.target.spaceId) || envelope.resource.kind !== record.resource.kind || envelope.resource.path !== record.resource.path
    || (record.ownerDid !== undefined && record.ownerDid !== ownerDid)) fail("Policy/v3 chain is not this record's");
  const root = parseSignedUcan(envelope.policyRoot.authorization, envelope.policyRoot.cid);
  const expiry = Math.min(Date.parse(binding.expiresAt), root.expiresAt * 1000, Date.parse(envelope.expiry));
  const expired = expiry <= context.now.getTime();
  const claims = [envelope.policyCid, envelope.policyRoot.cid, envelope.enforcementRoot.cid];
  const session = record.proofs?.session;
  const issued = around(Date.parse(binding.issuedAt));
  if (session === undefined) return { ok: true, state: "unproven", expired, claims, issued };
  // Roots are proofless (the node checks owner authority itself), so the CACAO is bound by audience, issuer and attenuation.
  const parent = await verifyOwnerSessionDelegation({ authorization: session, expectedCid: cacaoCid(session), accountOwnerDid: context.accountOwnerDid, childIssuer: root.issuer, childAttenuation: root.attenuation, now: context.now, parse: context.parseSiweCacao });
  return { ok: true, state: principalOf(ownerDid) === principalOf(context.agentDid) ? "proven" : "chained", expired: expired || parent.time === "expired", claims, issued };
}

async function ownerPolicyV2Chain(record: StoredShareRecord, context: ChainContext): Promise<ChainVerdict> {
  const proofs = record.proofs!;
  if (proofs.ownerDelegation === undefined || proofs.enforcementDelegation === undefined || record.policyCid === undefined || record.ownerDelegationCid === undefined || record.enforcementDelegationCid === undefined) fail("Policy/v2 chain is incomplete");
  const policyBytes = fromBase64Url(proofs.ownerPolicy!);
  if (await computeCid(policyBytes) !== record.policyCid) fail("Policy/v2 policy bytes do not match policyCid");
  let envelope: { readonly domain?: unknown; readonly policy?: Record<string, unknown> };
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policyBytes)) as typeof envelope; } catch { fail("Policy/v2 policy is not JSON"); }
  const policy = envelope.policy;
  const target = policy?.target as Record<string, unknown> | undefined;
  const resource = policy?.resource as Record<string, unknown> | undefined;
  if (envelope.domain !== "xyz.tinycloud.share/policy/v2\0" || policy === undefined || typeof policy.shareKeyDid !== "string" || typeof policy.ownerDid !== "string" || typeof policy.contentSourceDigest !== "string"
    || policy.shareId !== record.shareId || typeof target?.spaceId !== "string" || canonicalAddressSpelling(target.spaceId) !== canonicalAddressSpelling(record.target.spaceId)
    || resource?.kind !== record.resource.kind || resource?.path !== record.resource.path
    || canonicalAddressSpelling(policy.ownerDid) !== canonicalAddressSpelling(context.accountOwnerDid)) fail("Policy/v2 policy is not this record's");
  const shareKeyDid = policy.shareKeyDid;
  const enforcement = await verifyPolicyEnforcementDelegation(proofs.enforcementDelegation, record.enforcementDelegationCid);
  const facts = enforcement.facts;
  if (enforcement.issuerDid !== shareKeyDid || facts.policyCid !== record.policyCid || facts.ownerDelegationCid !== record.ownerDelegationCid || facts.shareId !== record.shareId
    || typeof facts.spaceId !== "string" || canonicalAddressSpelling(facts.spaceId) !== canonicalAddressSpelling(record.target.spaceId) || facts.path !== record.resource.path || typeof facts.expiresAt !== "string") fail("enforcement delegation is not this record's");
  const owner = await verifyOwnerSessionDelegation({
    authorization: proofs.ownerDelegation, expectedCid: record.ownerDelegationCid, accountOwnerDid: context.accountOwnerDid, childIssuer: shareKeyDid,
    childAttenuation: { [kvResource(record)]: Object.fromEntries(record.actions.map((action) => [action, [{}]])) }, now: context.now, parse: context.parseSiweCacao,
  });
  let expired = owner.time === "expired" || Date.parse(facts.expiresAt as string) <= context.now.getTime();
  const claims = [record.policyCid, record.ownerDelegationCid, record.enforcementDelegationCid];
  let issued: { readonly earliest?: number; readonly latest?: number } = { latest: Date.parse(facts.expiresAt as string) };
  const key = context.registrationKey?.(record.target.nodeAudience);
  if (record.registrationCid !== undefined && proofs.registration !== undefined && key !== undefined) {
    let checked: CheckedRegistration;
    try {
      checked = checkRegistrationReceipt(proofs.registration, { policyCid: record.policyCid, ownerDelegationCid: record.ownerDelegationCid, enforcementDelegationCid: record.enforcementDelegationCid, policy, enforcementFacts: facts }, key, context.now);
    } catch {
      fail("registration receipt is invalid");
    }
    const registration = checked.registration;
    if (registration.registrationCid !== record.registrationCid || registration.shareId !== record.shareId || registration.ownerDid !== policy.ownerDid || registration.shareKeyDid !== shareKeyDid || registration.enforcerDid !== enforcement.audienceDid) fail("registration receipt is not this record's");
    expired ||= checked.status === "expired";
    claims.push(record.registrationCid);
    issued = around(Date.parse(registration.registeredAt));
  }
  return { ok: true, state: "chained", expired, claims, issued };
}

/** Verify the chain behind every CID a stored agent (or migrated) record claims. Never throws. */
export async function verifyAgentRecordChain(record: StoredShareRecord, context: ChainContext): Promise<ChainVerdict> {
  try {
    const proofs = record.proofs;
    if (proofs?.ownerPolicy !== undefined) return await ownerPolicyV2Chain(record, context);
    if (record.targetKind !== undefined && record.targetKind !== "bearer") {
      const material = record.deliveryMaterial;
      if (material === undefined) fail("Policy/v3 record carries no delivery material");
      // The CIDs the record names for its sealed envelope are that envelope's.
      if ((record.shareCid !== undefined && record.shareCid !== material.shareCid) || (record.envelopeCid !== undefined && record.envelopeCid !== material.shareCid)) fail("Policy/v3 record names another sealed envelope");
      let envelope: unknown;
      try { envelope = await openDeliveryEnvelope(material); } catch { fail("Policy/v3 delivery material does not open to its envelope"); }
      return await policyV3Chain(record, envelope, context);
    }
    if (proofs?.link !== undefined) return await bearerChain(record, proofs.link, context);
    return { ok: false, detail: "record carries no proof" };
  } catch (error) {
    return { ok: false, detail: error instanceof ProofFailure ? error.message : "proof does not verify" };
  }
}
