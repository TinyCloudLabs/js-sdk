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

/** Challenge as returned by the node. `expiresAt` is required here, unlike sdk-core's optional field. */
export type SharePresentationChallenge = {
  readonly challengeId: string;
  readonly nonce: string;
  readonly policyCid: string;
  readonly recipientDid: string;
  readonly nodeAudience: string;
  readonly expiresAt: string;
};

export interface BuildSharePresentationInput {
  readonly holderSigner: HolderSigner;
  readonly result: EmailProofResult;
  readonly requirement: CredentialRequirement;
  readonly challenge: SharePresentationChallenge;
  /** Untrusted until validated against challenge.policyCid. */
  readonly policy: unknown;
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
 * with one code. The sdk-core builder re-checks everything else and any builder
 * rejection maps to PRESENTATION_REJECTED. Signing is delegated to the
 * holder signer over the 32-byte V4 digest; no hashing happens here.
 */
export async function buildSharePresentation(
  input: BuildSharePresentationInput,
): Promise<SharePresentationMaterial> {
  const { holderSigner, result, requirement, challenge } = input;

  const expiresMs = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    throw new SharePresentationError("CHALLENGE_EXPIRED", "policy challenge is expired");
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
