import {
  buildPolicyCredentialPresentationV4,
  credentialRequirementDigest,
  normalizeUnifiedPolicyCapability,
  unifiedPolicyCapabilityContains,
  validateUnifiedPolicyV2,
  type CredentialRequirement,
  type IssuedCredentialEnvelope,
  type PolicyCredentialPresentationV4,
  type UnifiedPolicyCapability,
  type UnifiedPolicyV2,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import type { EmailProofResult, HolderSigner } from "./email-proof";

export type SharePresentationErrorCode =
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_IDENTIFIER_INVALID"
  | "CHALLENGE_ROUTE_UNSUPPORTED"
  | "CHALLENGE_AUDIENCE_MISMATCH"
  | "CHALLENGE_RECIPIENT_MISMATCH"
  | "HOLDER_MISMATCH"
  | "HOLDER_ALG_UNSUPPORTED"
  | "CREDENTIAL_MISMATCH"
  | "CREDENTIAL_EXPIRED"
  | "CREDENTIAL_TOO_OLD"
  | "POLICY_INVALID"
  | "POLICY_CID_MISMATCH"
  | "REQUIREMENT_MISMATCH"
  | "REQUESTED_CAPABILITIES_INVALID"
  | "CAPABILITY_OUTSIDE_CEILING"
  | "PRESENTATION_REJECTED";

/** Typed rejection. Messages are fixed strings: they never include DIDs, digests, or credential text. */
export class SharePresentationError extends Error {
  readonly code: SharePresentationErrorCode;

  constructor(code: SharePresentationErrorCode, message: string) {
    super(message);
    this.name = "SharePresentationError";
    this.code = code;
  }
}

/**
 * Floor for challengeId and nonce. A floor, not a security claim: the node's generator
 * and its minimum length are NOT CONFIRMED from this checkout.
 */
const CHALLENGE_IDENTIFIER_MIN_LENGTH = 16;

/** Ceiling on challengeId and nonce length. Bounds what the holder is asked to sign; node length not confirmed. */
const CHALLENGE_IDENTIFIER_MAX_LENGTH = 256;

/**
 * Local fail-closed margin on the credential's own expiry (CREDENTIAL_EXPIRED). Courier's
 * StoredCredentialSource.find (packages/courier/src/credential-source.ts) applies NO margin: it
 * relies on sdk-core credentialMatchesRequirement (strict expiresAt <= now). This 60 s value is a
 * stricter local choice, not a Courier constant.
 */
const CREDENTIAL_EXPIRY_MARGIN_MS = 60_000;

/**
 * Node status freshness for the reviewed OpenCredentials email profiles: 300 s (policy_v3.rs:87),
 * applied by pinned_profile_status_freshness_seconds (policy_v3.rs:5929-5949) on top of any
 * requirement maxAgeSeconds. The stricter limit applies.
 */
const EMAIL_STATUS_FRESHNESS_SECONDS = 300;
const EMAIL_PINNED_PROFILE_IDS: readonly string[] = ["tinycloud.email-proof/v1", "tinycloud.email-domain-proof/v1"];
const EMAIL_CREDENTIAL_TYPE_ID = "opencredentials.email/v1";

/** Audience pin shape: printable ASCII, no whitespace or control characters. */
const NODE_AUDIENCE_SHAPE = /^[\x21-\x7e]+$/;

/**
 * Policy-v3 challenge as returned by the node (policy_v3.rs:1665-1673): challengeId, nonce,
 * policyCid, recipientDid, expiresAt, and an optional nodeAudience. nodeAudience is omitted for
 * non-POLICY_V2 policies (policy_v3.rs:2095); the caller's expectedNodeAudience supplies it.
 * Route-A (share-mint) challenges are rejected at runtime by isRouteAShaped.
 */
export type SharePresentationChallenge = {
  readonly challengeId: string;
  readonly nonce: string;
  readonly policyCid: string;
  readonly recipientDid: string;
  readonly expiresAt: string;
  readonly nodeAudience?: string;
};

export interface BuildSharePresentationInput {
  readonly holderSigner: HolderSigner;
  readonly result: EmailProofResult;
  readonly requirement: CredentialRequirement;
  readonly challenge: SharePresentationChallenge;
  /** Untrusted until validated against challenge.policyCid. */
  readonly policy: unknown;
  /**
   * Node audience the CALLER trusts, taken from its own verified share envelope and not from the
   * relay challenge: `PublishedShareEnvelopeV2.target.nodeAudience` (sdk-core delegations/share-envelope.ts:502)
   * or `AttestedEnforcerBindingV2.nodeAudience` (sdk-core policy/unified.ts:123). Empty fails closed.
   * If challenge.nodeAudience is present and differs, fails closed with CHALLENGE_AUDIENCE_MISMATCH.
   * Always written into the V4 body as nodeAudience.
   */
  readonly expectedNodeAudience: string;
  /**
   * Capabilities requested at challenge time, sent to the node as-is. Required: non-empty, each entry
   * inside policy.capabilityCeiling. The same set is signed into the V4 body.
   */
  readonly requestedCapabilities: readonly UnifiedPolicyCapability[];
}

export interface SharePresentationMaterial {
  readonly holderDid: string;
  readonly credential: string;
  readonly credentialDigest: string;
  readonly credentialEnvelope: IssuedCredentialEnvelope;
  readonly requirement: CredentialRequirement;
  readonly presentation: PolicyCredentialPresentationV4;
  /**
   * Raw holder signature over exactly the bytes given (no hashing or prefixing). Same key authority as
   * the holderSigner the caller passed in: it adds no signing power. Holder-key-bearing; do not persist,
   * log, or forward it to less-trusted code.
   */
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Route-A (share-mint) markers. A challenge carrying any of these, or type
 * TinyCloudSharePolicyChallenge, is share-route shaped (share_email.rs:2505-2530) and is
 * rejected: this builder only accepts the policy-v3 challenge (policy_v3.rs:1665-1673).
 */
const ROUTE_A_MARKERS = ["action", "enforcerDid", "shareCid", "authorityMaterialHandle"] as const;

function isRouteAShaped(challenge: unknown): boolean {
  const fields = challenge as Record<string, unknown>;
  return fields.type === "TinyCloudSharePolicyChallenge" ||
    ROUTE_A_MARKERS.some((key) => fields[key] !== undefined);
}

/**
 * Effective credential age limit in seconds, or undefined when neither limit applies. The node enforces
 * two independent limits from issuedAt (policy_v3.rs:6340-6370): the requirement's maxAgeSeconds and the
 * 300 s pin for the reviewed email profiles. The effective limit is the stricter of the two.
 */
function credentialAgeLimitSeconds(credential: VerifiedCredential, requirement: CredentialRequirement): number | undefined {
  const pinned = EMAIL_PINNED_PROFILE_IDS.includes(credential.profile.id) &&
    credential.credentialType.id === EMAIL_CREDENTIAL_TYPE_ID;
  const maxAge = requirement.maxAgeSeconds;
  if (!pinned) return maxAge;
  return maxAge === undefined ? EMAIL_STATUS_FRESHNESS_SECONDS : Math.min(EMAIL_STATUS_FRESHNESS_SECONDS, maxAge);
}

/**
 * Build the signed V4 policy presentation for a Share mint.
 *
 * Checks run in fail-closed order; each failure throws a SharePresentationError
 * with one code. Route shape and audience are pinned first, so a relay cannot steer the
 * holder into signing for a node it did not name in the caller's own envelope.
 * The V4 body's nodeAudience is always expectedNodeAudience: the node omits
 * challenge.nodeAudience for non-POLICY_V2 policies (policy_v3.rs:2095), and sdk-core
 * requires it non-empty. The sdk-core builder re-checks everything else and any builder
 * rejection maps to PRESENTATION_REJECTED. Signing is delegated to the holder signer
 * over the 32-byte V4 digest; no hashing happens here.
 *
 * Holder algorithm must be EdDSA. The credential must expire more than 60 seconds from now. This local
 * margin is the builder's choice, not a node rule: Courier applies none.
 * Credential age is measured from issuedAt against the stricter of the requirement's maxAgeSeconds and,
 * for the reviewed OpenCredentials email profiles (tinycloud.email-proof/v1 and tinycloud.email-domain-proof/v1
 * with credentialType opencredentials.email/v1), the node's 300-second status pin (policy_v3.rs:87,
 * :5929-5949). Any other profile with no maxAgeSeconds has no age limit, and none is added here.
 * requestedCapabilities is required: non-empty, every entry inside policy.capabilityCeiling, and the same
 * set is signed exactly as given. Pass the set sent at challenge time: the node compares it as a set
 * (policy_v3.rs:5847-5853). The challenge is taken as the node issues it (300-second lifetime,
 * policy_v3.rs:2075); no lifetime bound beyond expiry is applied.
 */
export async function buildSharePresentation(
  input: BuildSharePresentationInput,
): Promise<SharePresentationMaterial> {
  const { holderSigner, result, requirement, challenge } = input;

  if (isRouteAShaped(challenge)) {
    throw new SharePresentationError("CHALLENGE_ROUTE_UNSUPPORTED", "policy challenge is share-route shaped; only the policy-v3 route is supported");
  }
  if (
    typeof input.expectedNodeAudience !== "string" ||
    input.expectedNodeAudience.length === 0 ||
    !NODE_AUDIENCE_SHAPE.test(input.expectedNodeAudience) ||
    (challenge.nodeAudience !== undefined && challenge.nodeAudience !== input.expectedNodeAudience)
  ) {
    throw new SharePresentationError("CHALLENGE_AUDIENCE_MISMATCH", "policy challenge audience is not the expected node");
  }

  const nowMs = Date.now();
  const expiresMs = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw new SharePresentationError("CHALLENGE_EXPIRED", "policy challenge is expired");
  }

  const identifiersOk = [challenge.challengeId, challenge.nonce].every(
    (value) => typeof value === "string" && value.length >= CHALLENGE_IDENTIFIER_MIN_LENGTH && value.length <= CHALLENGE_IDENTIFIER_MAX_LENGTH,
  );
  if (!identifiersOk) {
    throw new SharePresentationError("CHALLENGE_IDENTIFIER_INVALID", "policy challenge identifiers are missing or outside the length bounds");
  }

  const holderDid = result.verified.holderDid;
  if (holderSigner.did !== holderDid) {
    throw new SharePresentationError("HOLDER_MISMATCH", "holder signer does not match the credential holder");
  }
  if (holderSigner.alg !== "EdDSA") {
    throw new SharePresentationError("HOLDER_ALG_UNSUPPORTED", "holder signer algorithm is not EdDSA");
  }
  if (challenge.recipientDid !== holderSigner.did) {
    throw new SharePresentationError("CHALLENGE_RECIPIENT_MISMATCH", "policy challenge recipient is not the holder signer");
  }
  if (result.envelope.credential !== result.verified.credential) {
    throw new SharePresentationError("CREDENTIAL_MISMATCH", "credential envelope does not match verified credential");
  }

  // Credential freshness, checked on the verified credential. The expiry must be more than
  // CREDENTIAL_EXPIRY_MARGIN_MS after now; an unparseable expiry fails closed.
  const credentialExpiresMs = Date.parse(result.verified.expiresAt);
  if (!Number.isFinite(credentialExpiresMs) || credentialExpiresMs - nowMs <= CREDENTIAL_EXPIRY_MARGIN_MS) {
    throw new SharePresentationError("CREDENTIAL_EXPIRED", "credential is expired or within the expiry margin");
  }
  // Credential age: the node enforces the stricter of maxAgeSeconds and the 300 s email pin, measured
  // from issuedAt (policy_v3.rs:6340-6370). Refused only when strictly older than the limit.
  const ageLimitSeconds = credentialAgeLimitSeconds(result.verified, requirement);
  if (ageLimitSeconds !== undefined) {
    const issuedMs = Date.parse(result.verified.issuedAt);
    if (!Number.isFinite(issuedMs) || nowMs - issuedMs > ageLimitSeconds * 1000) {
      throw new SharePresentationError("CREDENTIAL_TOO_OLD", "credential is older than its freshness limit");
    }
  }

  try {
    validateUnifiedPolicyV2(input.policy);
  } catch {
    throw new SharePresentationError("POLICY_INVALID", "policy is invalid");
  }
  let policy: UnifiedPolicyV2;
  try {
    policy = validateUnifiedPolicyV2(input.policy, challenge.policyCid);
  } catch {
    throw new SharePresentationError("POLICY_CID_MISMATCH", "policy does not match the challenge policy CID");
  }

  let requirementDigest: string;
  try {
    requirementDigest = await credentialRequirementDigest(requirement);
  } catch {
    throw new SharePresentationError("REQUIREMENT_MISMATCH", "credential requirement is invalid");
  }
  if (requirementDigest !== policy.credentialRequirement.requirementDigest) {
    throw new SharePresentationError("REQUIREMENT_MISMATCH", "credential requirement does not match the policy");
  }

  // Requested capabilities are signed exactly as the caller sent them, so they must be a non-empty set
  // inside the policy ceiling (node: policy_v3.rs:2061-2067 at challenge; :5847-5853 V4 set equality).
  // Checked before any signing.
  if (!Array.isArray(input.requestedCapabilities) || input.requestedCapabilities.length === 0) {
    throw new SharePresentationError("REQUESTED_CAPABILITIES_INVALID", "requested capabilities must be a non-empty set");
  }
  let requestedCapabilities: UnifiedPolicyCapability[];
  try {
    requestedCapabilities = input.requestedCapabilities.map((entry) => normalizeUnifiedPolicyCapability(entry));
  } catch {
    throw new SharePresentationError("REQUESTED_CAPABILITIES_INVALID", "requested capability is malformed");
  }
  if (requestedCapabilities.some((requested) =>
    !policy.capabilityCeiling.some((authority) => unifiedPolicyCapabilityContains(authority, requested)))) {
    throw new SharePresentationError("CAPABILITY_OUTSIDE_CEILING", "requested capability is outside the policy capability ceiling");
  }

  let presentation: PolicyCredentialPresentationV4;
  try {
    presentation = await buildPolicyCredentialPresentationV4({
      policy,
      policyCid: challenge.policyCid,
      challenge: {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        policyCid: challenge.policyCid,
        recipientDid: challenge.recipientDid,
        expiresAt: challenge.expiresAt,
        nodeAudience: input.expectedNodeAudience,
      },
      requirement,
      credential: result.verified,
      requestedCapabilities,
      sign: holderSigner.sign,
    });
  } catch {
    throw new SharePresentationError("PRESENTATION_REJECTED", "sdk-core rejected the presentation");
  }

  return Object.freeze({
    holderDid,
    credential: result.verified.credential,
    credentialDigest: result.verified.credentialDigest,
    credentialEnvelope: result.envelope,
    requirement,
    presentation,
    sign: holderSigner.sign,
  });
}
