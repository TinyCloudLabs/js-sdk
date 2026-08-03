import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  credentialRequirementDigest,
  validateCredentialRequirement,
} from "../credentials/requirement";
import {
  encodeBase64Url,
  isDigest,
  sha256Base64Url,
} from "../credentials/digest";
import type {
  CredentialRequirement,
  IssuedCredentialEnvelope,
  VerifiedCredential,
} from "../credentials/types";
import { jcsCanonicalize } from "./jcs";
import {
  compactAttenuationForPolicyCapabilities,
  normalizeUnifiedPolicyCapability,
  parsePolicySessionUcan,
  policyCidFromCanonicalBytes,
  policyIdForDigestHex,
  requestPolicyChallengeV3,
  unifiedPolicyCapabilityContains,
  type PolicyChallengeV3,
  type PolicySessionUcanV1,
  type UnifiedContentSource,
  type UnifiedPolicyCapability,
} from "./unified";

export const POLICY_V2_SCHEMA = "xyz.tinycloud.policy/policy/v2" as const;
export const POLICY_V2_DOMAIN = "xyz.tinycloud.policy/policy/v2\0";
export const POLICY_CREDENTIAL_REQUIREMENT_V1_TYPE =
  "TinyCloudPolicyCredentialRequirement" as const;
export const POLICY_PRESENTATION_V3_SCHEMA =
  "xyz.tinycloud.policy/presentation/v3" as const;
export const POLICY_PRESENTATION_V3_DOMAIN =
  "xyz.tinycloud.policy/Presentation/v3\0";

export interface PolicyCredentialRequirementV1 {
  readonly type: typeof POLICY_CREDENTIAL_REQUIREMENT_V1_TYPE;
  readonly version: 1;
  readonly requirementDigest: string;
  readonly descriptorDigest: string;
  readonly issuerDid: string;
  readonly issuerKid: string;
  readonly profile: { readonly id: string; readonly version: 1 };
  readonly credentialType: { readonly id: string; readonly version: 1 };
}

export interface UnifiedPolicyV2 {
  readonly schema: typeof POLICY_V2_SCHEMA;
  readonly policyId: string;
  readonly ownerDid: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly contentSource: UnifiedContentSource;
  readonly capabilityCeiling: readonly UnifiedPolicyCapability[];
  readonly credentialRequirement: PolicyCredentialRequirementV1;
  readonly signature: {
    readonly suite: "Ed25519";
    readonly signerDid: string;
    readonly value: string;
  };
}

export type UnsignedUnifiedPolicyV2 = Omit<
  UnifiedPolicyV2,
  "policyId" | "signature"
>;

export interface PolicyCredentialPresentationV3 {
  readonly schema: typeof POLICY_PRESENTATION_V3_SCHEMA;
  readonly jti: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly policyCid: string;
  readonly nodeAudience: string;
  readonly holderDid: string;
  readonly subjectDid: string;
  readonly credentialSpaceOwnerDid: string;
  readonly credentialDigest: string;
  readonly requirementDigest: string;
  readonly descriptorDigest: string;
  readonly requestedCapabilities: readonly UnifiedPolicyCapability[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: {
    readonly suite: "Ed25519";
    readonly signerDid: string;
    readonly value: string;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains an unknown or missing field`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function policyNodeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("policy node origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("policy node origin is invalid");
  }
  return url.origin;
}

function versionPair(
  value: unknown,
  label: string,
): { readonly id: string; readonly version: 1 } {
  const item = record(value, label);
  exactKeys(item, ["id", "version"], label);
  if (item.version !== 1) throw new Error(`${label} version is unsupported`);
  return Object.freeze({ id: nonEmpty(item.id, `${label}.id`), version: 1 });
}

export function validatePolicyCredentialRequirementV1(
  value: unknown,
): PolicyCredentialRequirementV1 {
  const item = record(value, "policy credential requirement");
  exactKeys(
    item,
    [
      "type",
      "version",
      "requirementDigest",
      "descriptorDigest",
      "issuerDid",
      "issuerKid",
      "profile",
      "credentialType",
    ],
    "policy credential requirement",
  );
  if (
    item.type !== POLICY_CREDENTIAL_REQUIREMENT_V1_TYPE ||
    item.version !== 1 ||
    !isDigest(item.requirementDigest) ||
    !isDigest(item.descriptorDigest)
  ) {
    throw new Error("policy credential requirement is invalid");
  }
  return Object.freeze({
    type: POLICY_CREDENTIAL_REQUIREMENT_V1_TYPE,
    version: 1,
    requirementDigest: item.requirementDigest,
    descriptorDigest: item.descriptorDigest,
    issuerDid: nonEmpty(item.issuerDid, "policy credential issuer"),
    issuerKid: nonEmpty(item.issuerKid, "policy credential issuer key"),
    profile: versionPair(item.profile, "policy credential profile"),
    credentialType: versionPair(
      item.credentialType,
      "policy credential type",
    ),
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function policyV2DigestHex(input: UnsignedUnifiedPolicyV2): string {
  const canonicalPolicy = {
    ...input,
    credentialRequirement: validatePolicyCredentialRequirementV1(
      input.credentialRequirement,
    ),
    capabilityCeiling: input.capabilityCeiling.map(
      normalizeUnifiedPolicyCapability,
    ),
  };
  return hex(
    sha256(
      new TextEncoder().encode(
        POLICY_V2_DOMAIN + jcsCanonicalize(canonicalPolicy),
      ),
    ),
  );
}

function date(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} is invalid`);
  return text;
}

function rfc3339Seconds(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1000) * 1000)
    .toISOString()
    .replace(/\.000Z$/, "Z");
}

/**
 * Validate the exact non-PII Policy/v2 commitment consumed by the holder.
 * The caller supplies policy bytes already owner-signature verified by Share;
 * Node remains the authoritative signature verifier at admission.
 */
export function validateUnifiedPolicyV2(
  value: unknown,
  expectedPolicyCid?: string,
): UnifiedPolicyV2 {
  const item = record(value, "Policy/v2");
  const allowed = [
    "schema",
    "policyId",
    "ownerDid",
    "createdAt",
    "contentSource",
    "capabilityCeiling",
    "credentialRequirement",
    "signature",
    ...(item.expiresAt === undefined ? [] : ["expiresAt"]),
  ];
  exactKeys(item, allowed, "Policy/v2");
  if (item.schema !== POLICY_V2_SCHEMA || !Array.isArray(item.capabilityCeiling)) {
    throw new Error("Policy/v2 is invalid");
  }
  const ownerDid = nonEmpty(item.ownerDid, "Policy/v2 ownerDid");
  const signature = record(item.signature, "Policy/v2 signature");
  exactKeys(signature, ["suite", "signerDid", "value"], "Policy/v2 signature");
  if (
    signature.suite !== "Ed25519" ||
    signature.signerDid !== ownerDid ||
    typeof signature.value !== "string" ||
    signature.value.length === 0
  ) {
    throw new Error("Policy/v2 signature binding is invalid");
  }
  const policy = Object.freeze({
    schema: POLICY_V2_SCHEMA,
    policyId: nonEmpty(item.policyId, "Policy/v2 policyId"),
    ownerDid,
    createdAt: date(item.createdAt, "Policy/v2 createdAt"),
    ...(item.expiresAt === undefined
      ? {}
      : { expiresAt: date(item.expiresAt, "Policy/v2 expiresAt") }),
    contentSource: item.contentSource as UnifiedContentSource,
    capabilityCeiling: Object.freeze(
      item.capabilityCeiling.map(normalizeUnifiedPolicyCapability),
    ),
    credentialRequirement: validatePolicyCredentialRequirementV1(
      item.credentialRequirement,
    ),
    signature: Object.freeze({
      suite: "Ed25519" as const,
      signerDid: ownerDid,
      value: signature.value,
    }),
  });
  const unsigned = { ...policy } as Record<string, unknown>;
  delete unsigned.policyId;
  delete unsigned.signature;
  const digestHex = policyV2DigestHex(unsigned as UnsignedUnifiedPolicyV2);
  if (policy.policyId !== policyIdForDigestHex(digestHex)) {
    throw new Error("Policy/v2 policyId binding is invalid");
  }
  if (expectedPolicyCid !== undefined) {
    const cid = policyCidFromCanonicalBytes(
      new TextEncoder().encode(jcsCanonicalize(policy)),
    );
    if (cid !== expectedPolicyCid) throw new Error("Policy/v2 CID binding is invalid");
  }
  return policy;
}

function didKeyBytes(did: string): Uint8Array {
  const principal = did.split("#", 1)[0]!;
  if (!principal.startsWith("did:key:")) throw new Error("holder DID must be did:key");
  const material = base58btc.decode(principal.slice("did:key:".length));
  if (material.length !== 34 || material[0] !== 0xed || material[1] !== 0x01) {
    throw new Error("holder DID must contain an Ed25519 key");
  }
  return material.slice(2);
}

function envelopeFromVerified(
  verified: VerifiedCredential,
): IssuedCredentialEnvelope {
  const { verifiedAt: _verifiedAt, credentialDigest: _credentialDigest,
    statusCheckedAt: _statusCheckedAt, ...envelope } = verified;
  return envelope;
}

export interface BuildPolicyCredentialPresentationV3Input {
  readonly policy: UnifiedPolicyV2;
  readonly policyCid: string;
  readonly challenge: PolicyChallengeV3;
  readonly requirement: CredentialRequirement;
  readonly credential: VerifiedCredential;
  readonly credentialSpaceOwnerDid: string;
  readonly requestedCapabilities: readonly UnifiedPolicyCapability[];
  readonly sign: (digest: Uint8Array) => Promise<Uint8Array>;
  readonly now?: Date;
  readonly jti?: string;
}

export async function buildPolicyCredentialPresentationV3(
  input: BuildPolicyCredentialPresentationV3Input,
): Promise<PolicyCredentialPresentationV3> {
  const policy = validateUnifiedPolicyV2(input.policy, input.policyCid);
  const requirement = validateCredentialRequirement(input.requirement);
  const commitment = policy.credentialRequirement;
  const requirementDigest = await credentialRequirementDigest(requirement);
  const credentialDigest = await sha256Base64Url(input.credential.credential);
  if (
    requirementDigest !== commitment.requirementDigest ||
    input.credential.descriptorDigest !== commitment.descriptorDigest ||
    input.credential.credentialDigest !== credentialDigest ||
    input.credential.issuerDid !== commitment.issuerDid ||
    input.credential.issuerKid !== commitment.issuerKid ||
    jcsCanonicalize(input.credential.profile) !== jcsCanonicalize(commitment.profile) ||
    jcsCanonicalize(input.credential.credentialType) !==
      jcsCanonicalize(commitment.credentialType)
  ) {
    throw new Error("credential does not match the signed Policy/v2 requirement");
  }
  const requestedCapabilities = input.requestedCapabilities.map(
    normalizeUnifiedPolicyCapability,
  );
  if (
    requestedCapabilities.length === 0 ||
    requestedCapabilities.some(
      (requested) =>
        !policy.capabilityCeiling.some((authority) =>
          unifiedPolicyCapabilityContains(authority, requested),
        ),
    )
  ) {
    throw new Error("requested capabilities exceed the signed Policy/v2 ceiling");
  }
  const challenge = input.challenge;
  const holderDid = input.credential.holderDid;
  if (
    challenge.policyCid !== input.policyCid ||
    challenge.recipientDid !== holderDid ||
    input.credential.subjectDid !== holderDid ||
    typeof challenge.nodeAudience !== "string" ||
    challenge.nodeAudience.length === 0 ||
    typeof challenge.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(challenge.expiresAt))
  ) {
    throw new Error("policy challenge binding is invalid");
  }
  didKeyBytes(holderDid);
  const now = input.now ?? new Date();
  const challengeExpiry = Date.parse(challenge.expiresAt);
  const credentialExpiry = Date.parse(input.credential.expiresAt);
  const expiresAtMs = Math.min(
    now.getTime() + 60_000,
    challengeExpiry,
    credentialExpiry,
  );
  if (expiresAtMs <= now.getTime()) throw new Error("policy challenge is expired");
  const unsigned = Object.freeze({
    schema: POLICY_PRESENTATION_V3_SCHEMA,
    jti:
      input.jti ??
      encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    policyCid: input.policyCid,
    nodeAudience: challenge.nodeAudience,
    holderDid,
    subjectDid: input.credential.subjectDid,
    credentialSpaceOwnerDid: nonEmpty(
      input.credentialSpaceOwnerDid,
      "credential space owner DID",
    ),
    credentialDigest,
    requirementDigest,
    descriptorDigest: input.credential.descriptorDigest,
    requestedCapabilities: Object.freeze(requestedCapabilities),
    issuedAt: rfc3339Seconds(now),
    expiresAt: rfc3339Seconds(new Date(expiresAtMs)),
  });
  const digest = sha256(
    new TextEncoder().encode(
      POLICY_PRESENTATION_V3_DOMAIN + jcsCanonicalize(unsigned),
    ),
  );
  const signature = await input.sign(digest);
  if (
    signature.length !== 64 ||
    !ed25519.verify(signature, digest, didKeyBytes(holderDid))
  ) {
    throw new Error("policy presentation signature is invalid");
  }
  return Object.freeze({
    ...unsigned,
    signature: Object.freeze({
      suite: "Ed25519" as const,
      signerDid: holderDid,
      value: encodeBase64Url(signature),
    }),
  });
}

export interface AdmitPolicyCredentialV3Input
  extends Omit<BuildPolicyCredentialPresentationV3Input, "challenge"> {
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
  readonly nodeOrigin: string;
  readonly fetch?: typeof fetch;
}

export interface PolicyCredentialAdmissionV3 {
  readonly challenge: PolicyChallengeV3;
  readonly presentation: PolicyCredentialPresentationV3;
  readonly session: PolicySessionUcanV1;
}

/**
 * Present verified TC-463 output to the Policy/v3 admission ceremony.
 * Raw credential material appears only in the TLS POST body.
 */
export async function admitPolicyCredentialV3(
  input: AdmitPolicyCredentialV3Input,
): Promise<PolicyCredentialAdmissionV3> {
  const policy = validateUnifiedPolicyV2(input.policy, input.policyCid);
  const nodeOrigin = policyNodeOrigin(input.nodeOrigin);
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const challenge = await requestPolicyChallengeV3({
    nodeOrigin,
    policyCid: input.policyCid,
    recipientDid: input.credential.holderDid,
    requestedCapabilities: input.requestedCapabilities,
    fetch: fetchFn,
  });
  const presentation = await buildPolicyCredentialPresentationV3({
    ...input,
    policy,
    challenge,
  });
  const response = await fetchFn(
    new URL("/share/v3/policy/delegations", nodeOrigin),
    {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        policyCid: input.policyCid,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        requirement: validateCredentialRequirement(input.requirement),
        credential: envelopeFromVerified(input.credential),
        presentation,
      }),
    },
  );
  if (!response.ok) throw new Error(`policy delegation rejected (${response.status})`);
  const value = record(await response.json(), "policy delegation");
  if (
    value.admitted !== true ||
    typeof value.sessionCid !== "string" ||
    typeof value.authorization !== "string"
  ) {
    throw new Error("policy delegation response is invalid");
  }
  const session = parsePolicySessionUcan(value.authorization, [
    input.policyRootCid,
    input.enforcementRootCid,
  ]);
  const expectedAttenuation = compactAttenuationForPolicyCapabilities(
    input.requestedCapabilities,
  );
  if (
    session.cid !== value.sessionCid ||
    session.aud !== input.credential.holderDid ||
    session.fact.policyCid !== input.policyCid ||
    session.fact.recipientDid !== input.credential.holderDid ||
    session.fact.policyDelegationCid !== input.policyRootCid ||
    session.fact.enforcementDelegationCid !== input.enforcementRootCid ||
    jcsCanonicalize(session.att) !== jcsCanonicalize(expectedAttenuation)
  ) {
    throw new Error("policy delegation signed binding is invalid");
  }
  return Object.freeze({ challenge, presentation, session });
}
