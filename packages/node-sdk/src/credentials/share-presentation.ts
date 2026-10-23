import {
  buildPolicyCredentialPresentationV4,
  credentialRequirementDigest,
  validateUnifiedPolicyV2,
  type CredentialRequirement,
  type IssuedCredentialEnvelope,
  type PolicyCredentialPresentationV4,
  type UnifiedPolicyV2,
} from "@tinycloud/sdk-core";
import type { EmailProofResult, HolderSigner } from "./email-proof";

export type SharePresentationErrorCode =
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_WINDOW_TOO_LONG"
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

/** Same 60 s ceiling sdk-core clamps the presentation expiry to (credential-admission.ts:461-462). */
const CHALLENGE_MAX_WINDOW_MS = 60_000;

/**
 * Floor for challengeId and nonce. A floor, not a security claim: the node's generator
 * and its minimum length are NOT CONFIRMED from this checkout.
 */
const CHALLENGE_IDENTIFIER_MIN_LENGTH = 16;

/**
 * Local fail-closed margin on the credential's own expiry (CREDENTIAL_EXPIRED). Courier's
 * StoredCredentialSource.find (packages/courier/src/credential-source.ts) applies NO margin: it
 * relies on sdk-core credentialMatchesRequirement (strict expiresAt <= now). This 60 s value is a
 * stricter local choice, not a Courier constant.
 */
const CREDENTIAL_EXPIRY_MARGIN_MS = 60_000;

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
}

export interface SharePresentationMaterial {
  readonly holderDid: string;
  readonly credential: string;
  readonly credentialDigest: string;
  readonly credentialEnvelope: IssuedCredentialEnvelope;
  readonly requirement: CredentialRequirement;
  readonly presentation: PolicyCredentialPresentationV4;
  /**
   * Raw holder signature over exactly the bytes given (no hashing or prefixing). Bound to
   * the holder key from `holderSigner`; the signer object itself is not exposed.
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
 * Holder algorithm must be EdDSA. The credential must expire more than 60 seconds from now and,
 * when the requirement sets maxAgeSeconds, must have been issued no more than that long ago.
 * A requirement without maxAgeSeconds has no age limit; this builder does not invent one.
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
    (challenge.nodeAudience !== undefined && challenge.nodeAudience !== input.expectedNodeAudience)
  ) {
    throw new SharePresentationError("CHALLENGE_AUDIENCE_MISMATCH", "policy challenge audience is not the expected node");
  }

  const nowMs = Date.now();
  const expiresMs = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw new SharePresentationError("CHALLENGE_EXPIRED", "policy challenge is expired");
  }
  if (expiresMs - nowMs > CHALLENGE_MAX_WINDOW_MS) {
    throw new SharePresentationError("CHALLENGE_WINDOW_TOO_LONG", "policy challenge expiry is further out than 60 seconds");
  }

  const identifiersOk = [challenge.challengeId, challenge.nonce].every(
    (value) => typeof value === "string" && value.length >= CHALLENGE_IDENTIFIER_MIN_LENGTH,
  );
  if (!identifiersOk) {
    throw new SharePresentationError("CHALLENGE_IDENTIFIER_INVALID", "policy challenge identifiers are missing or too short");
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
  // maxAgeSeconds is measured from issuedAt (packages/sdk-core/src/credentials/requirement.ts:79).
  // A requirement without maxAgeSeconds has no age limit; none is added here.
  if (requirement.maxAgeSeconds !== undefined) {
    const issuedMs = Date.parse(result.verified.issuedAt);
    if (!Number.isFinite(issuedMs) || nowMs - issuedMs > requirement.maxAgeSeconds * 1000) {
      throw new SharePresentationError("CREDENTIAL_TOO_OLD", "credential is older than the requirement maxAgeSeconds");
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
      requestedCapabilities: policy.capabilityCeiling,
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
