import { admitPolicyCredentialV4, credentialMatchesRequirement, verifyOwnerNodeBinding, type CredentialRequirement, type UnifiedPolicyV2 } from "@tinycloud/sdk-core";
import { ShareReceiveError, ShareRecipientClient } from "@tinycloud/share-sdk";
import type { EmailProofResult } from "./credentials/email-proof.js";
import type { AgentShareContent, AgentShareReceiveOptions, PendingAgentShareReceive } from "./share-receive.js";

/** Internal access step. Tests supply a credential verified against a local issuer key. */
export async function openVerifiedAgentShare(
  pending: PendingAgentShareReceive,
  result: EmailProofResult,
  requirement: CredentialRequirement,
  options: AgentShareReceiveOptions,
): Promise<AgentShareContent> {
  const { envelope } = pending;
  if (!credentialMatchesRequirement(requirement, result.verified, options.holder.did, new Date(options.now?.() ?? Date.now()))) {
    throw new ShareReceiveError("authorization-denied", "email credential does not match this share");
  }
  if (envelope.target.nodeAudience !== envelope.attestedEnforcerBinding.nodeAudience) {
    throw new ShareReceiveError("envelope-invalid", "share Node binding is invalid");
  }
  try { await verifyOwnerNodeBinding({
    registryUrl: options.registryOrigin,
    ownerDid: envelope.policy.ownerDid,
    nodeOrigin: envelope.target.origin,
    nodeDid: envelope.target.nodeAudience,
    fetch: options.fetch,
    signal: options.signal,
  }); } catch {
    throw new ShareReceiveError("authorization-denied", "share owner Node binding could not be verified");
  }
  let admitted: Awaited<ReturnType<typeof admitPolicyCredentialV4>>;
  try { admitted = await admitPolicyCredentialV4({
    policy: envelope.policy as unknown as UnifiedPolicyV2,
    policyCid: envelope.policyCid,
    policyRootCid: envelope.policyRoot.cid,
    enforcementRootCid: envelope.enforcementRoot.cid,
    expectedNodeAudience: envelope.target.nodeAudience,
    expectedEnforcerDid: envelope.attestedEnforcerBinding.enforcerDid,
    requirement,
    credential: result.verified,
    requestedCapabilities: (envelope.policy as unknown as UnifiedPolicyV2).capabilityCeiling,
    requestedExpiresAt: envelope.expiry,
    sign: options.holder.sign,
    nodeOrigin: envelope.target.origin,
    fetch: options.fetch,
    signal: options.signal,
  }); } catch {
    throw new ShareReceiveError("authorization-denied", "share node refused the email credential");
  }
  const client = new ShareRecipientClient({
    nodeOrigin: envelope.target.origin,
    holderDid: options.holder.did,
    envelope,
    policyAuthorization: { authorization: admitted.session.authorization, cid: admitted.session.cid },
    sign: options.holder.sign,
    fetchFn: options.fetch,
    signal: options.signal,
  });
  let opened: Awaited<ReturnType<typeof client.decryptV3Content>>;
  try {
    const response = await client.nativeInvoke({ action: "get", resource: envelope.resource });
    if (!response.ok) throw new ShareReceiveError("authorization-denied", "share node refused the read");
    opened = await client.decryptV3Content(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    if (error instanceof ShareReceiveError) throw error;
    throw new ShareReceiveError("decrypt-failed", "share content could not be opened");
  }
  if (Date.parse(envelope.expiry) <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired");
  let text: string | undefined;
  if (/^(text\/|application\/(?:json|xml|javascript)(?:;|$))/.test(opened.mediaType)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(opened.bytes); } catch { /* Keep the verified bytes as binary data. */ }
  }
  return { metadata: pending.metadata, bytes: opened.bytes, ...(text === undefined ? {} : { text }), mediaType: opened.mediaType, untrusted: true };
}
