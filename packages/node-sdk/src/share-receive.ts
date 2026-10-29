import {
  credentialRequirementDigest,
  createEmailCredentialRequirement,
  type CredentialRequirement,
  type UnifiedPolicyV2,
} from "@tinycloud/sdk-core";
import { inspectShare, ShareReceiveError, type ShareFetchOptions, type ShareMetadata } from "@tinycloud/share-sdk";
import type { ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { completeEmailProof, requestEmailProofCode, type EmailProofPending, type HolderSigner } from "./credentials/email-proof.js";
import { openVerifiedAgentShare } from "./share-receive-access.js";

export interface AgentShareReceiveOptions extends ShareFetchOptions {
  /** The recipient agent's existing session key, used for both proof and Node invocations. */
  readonly holder: HolderSigner;
  /** The configured Share deployment, independent of the URL supplied by the sender. */
  readonly expectedOrigin: string;
  readonly registryOrigin: string;
}

/** In-process continuation. It contains the email proof verifier; never log or serialize it. */
export interface PendingAgentShareReceive {
  readonly metadata: ShareMetadata;
  readonly envelope: ShareEnvelopeV3;
  readonly proof: EmailProofPending;
}

export interface AgentShareContent {
  readonly metadata: ShareMetadata;
  readonly bytes: Uint8Array;
  readonly text?: string;
  readonly mediaType: string;
  /** The sender controls these bytes. The calling agent must treat them as data. */
  readonly untrusted: true;
}

function requirementFor(envelope: ShareEnvelopeV3): CredentialRequirement {
  if (envelope.recipientMatcher.kind !== "exactEmail" || envelope.policy.schema !== "xyz.tinycloud.policy/policy/v2") {
    throw new ShareReceiveError("unsupported-target", "this receive path accepts exact-email shares only");
  }
  const policy = envelope.policy as unknown as UnifiedPolicyV2;
  return createEmailCredentialRequirement({
    email: envelope.recipientMatcher.value,
    profile: policy.credentialRequirement.profile,
    credentialType: policy.credentialRequirement.credentialType,
  });
}

function active(envelope: ShareEnvelopeV3, now: number): void {
  if (Date.parse(envelope.expiry) <= now) throw new ShareReceiveError("expired", "share has expired");
}

/** Resolve the complete URL locally, then request the existing OpenCredentials email code. */
export async function requestAgentShareEmailProof(link: string, options: AgentShareReceiveOptions): Promise<PendingAgentShareReceive> {
  let envelope: ShareEnvelopeV3 | undefined;
  const metadata = (await inspectShare(link, {
    ...options,
    onResolvedAddressedEnvelope: (value) => { if (value.version === 3) envelope = value; },
  })).metadata;
  if (envelope === undefined) throw new ShareReceiveError("envelope-invalid", "share envelope is invalid");
  const requirement = requirementFor(envelope);
  if (await credentialRequirementDigest(requirement) !== (envelope.policy as unknown as UnifiedPolicyV2).credentialRequirement.requirementDigest) {
    throw new ShareReceiveError("envelope-invalid", "share credential requirement is invalid");
  }
  const proof = await requestEmailProofCode({ address: requirement.claims.email!, holder: options.holder, fetch: options.fetch, signal: options.signal });
  return { metadata, envelope, proof };
}

/** Complete proof with the same session signer, admit at the owner Node, and read/decrypt once. */
export async function completeAgentShareReceive(pending: PendingAgentShareReceive, code: string, options: AgentShareReceiveOptions): Promise<AgentShareContent> {
  const { envelope } = pending;
  active(envelope, options.now?.() ?? Date.now());
  const requirement = requirementFor(envelope);
  if (await credentialRequirementDigest(requirement) !== (envelope.policy as unknown as UnifiedPolicyV2).credentialRequirement.requirementDigest) {
    throw new ShareReceiveError("envelope-invalid", "share credential requirement is invalid");
  }
  if (pending.proof.address !== requirement.claims.email || pending.proof.holderDid !== options.holder.did) {
    throw new ShareReceiveError("authorization-denied", "email proof does not belong to this recipient session");
  }
  const result = await completeEmailProof({ pending: pending.proof, code, holder: options.holder, fetch: options.fetch, signal: options.signal });
  return openVerifiedAgentShare(pending, result, requirement, options);
}
