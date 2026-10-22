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
  | "CHALLENGE_AUDIENCE_MISMATCH"
  | "CHALLENGE_ACTION_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "HOLDER_MISMATCH"
  | "CREDENTIAL_MISMATCH"
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
 * Challenge as returned by the node. `expiresAt` is required here, unlike sdk-core's optional field.
 *
 * NOT CONFIRMED: sdk-core's PolicyChallengeV3 (policy/unified.ts:161-169) declares neither
 * `action` nor `enforcerDid`. This builder requires `action`, so a node challenge without it
 * fails closed with CHALLENGE_ACTION_MISMATCH.
 */
export type SharePresentationChallenge = {
  readonly challengeId: string;
  readonly nonce: string;
  readonly policyCid: string;
  readonly recipientDid: string;
  readonly nodeAudience: string;
  readonly action: string;
  readonly expiresAt: string;
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
   * or `AttestedEnforcerBindingV2.nodeAudience` (sdk-core policy/unified.ts:123). Compared to
   * `challenge.nodeAudience`. Empty or mismatched fails closed before signing.
   */
  readonly expectedNodeAudience: string;
  /**
   * Action the CALLER intends to present for, e.g. the action its share envelope grants.
   * Compared to `challenge.action`. Empty or mismatched fails closed before signing.
   */
  readonly expectedAction: string;
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
 * Build the signed V4 policy presentation for a Share mint.
 *
 * Checks run in fail-closed order; each failure throws a SharePresentationError
 * with one code. Audience and action are pinned to the caller's expectations first,
 * so a relay cannot steer the holder into signing for a node it did not name in the
 * caller's own envelope. The sdk-core builder re-checks everything else and any builder
 * rejection maps to PRESENTATION_REJECTED. Signing is delegated to the holder signer
 * over the 32-byte V4 digest; no hashing happens here.
 */
export async function buildSharePresentation(
  input: BuildSharePresentationInput,
): Promise<SharePresentationMaterial> {
  const { holderSigner, result, requirement, challenge } = input;

  if (
    typeof input.expectedNodeAudience !== "string" ||
    input.expectedNodeAudience.length === 0 ||
    challenge.nodeAudience !== input.expectedNodeAudience
  ) {
    throw new SharePresentationError("CHALLENGE_AUDIENCE_MISMATCH", "policy challenge audience is not the expected node");
  }
  if (
    typeof input.expectedAction !== "string" ||
    input.expectedAction.length === 0 ||
    challenge.action !== input.expectedAction
  ) {
    throw new SharePresentationError("CHALLENGE_ACTION_MISMATCH", "policy challenge action is not the expected action");
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
  if (challenge.recipientDid !== holderDid) {
    throw new SharePresentationError("RECIPIENT_MISMATCH", "policy challenge recipient is not the credential holder");
  }
  if (result.envelope.credential !== result.verified.credential) {
    throw new SharePresentationError("CREDENTIAL_MISMATCH", "credential envelope does not match verified credential");
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
      challenge,
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
