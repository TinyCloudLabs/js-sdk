import { randomBytes } from "node:crypto";
import { activateValidatedRuntimeDelegation, type PortableDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import type { Ed25519PrivateJwk, ShareInvitationApprovalContext } from "@tinycloud/share-envelope/links";
import { acquireApprovalRequest, invitationGrantOf, pendingInvitationContext, takeInvitationApproval } from "../auth/approval-request.js";
import { invitationKeyFromGrant } from "../auth/invitation-key-grant.js";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

const DAY_MS = 86_400_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of time, 80 random bits, Crockford base32. */
function newInvitationId(now: number): string {
  let id = "";
  let time = now;
  for (let index = 0; index < 10; index += 1) {
    id = CROCKFORD[time % 32]! + id;
    time = Math.floor(time / 32);
  }
  for (const byte of randomBytes(16)) id += CROCKFORD[byte % 32]!;
  return id.slice(0, 26);
}

/** What an approved invitation gives the share: the key id (from the signed grant only). The grant itself is installed on the profile's node. */
export interface EmailInviteKey {
  shareId: string;
}

export interface EmailInviteApprovalRequest {
  node: TinyCloudNode;
  profile: string;
  recipientEmail: string;
  /** The shared file name (or session name), shown to the approver with the recipient and dates. */
  subjectName: string;
  subjectKind: "file" | "session";
  /** When the shared content stops being readable by the recipient. */
  accessExpiresAt: Date;
  onApprovalRequest?: (request: { approvalUrl: string; requestId: string; expiresAt: string }) => void;
}

export type EmailInviteApprover = (request: EmailInviteApprovalRequest) => Promise<EmailInviteKey>;

/**
 * Ask the owner for one approval for this invitation's Share key, wait for it, verify the owner-signed grant for THIS request and
 * install it on the profile's own node as a runtime delegation (the same path the CLI's escalation grants use). Nothing is created
 * before the approval. A rerun while the approval is open continues the same request; the approval can be taken once.
 */
export const approveEmailInviteKey: EmailInviteApprover = async (request) => {
  const { node, profile } = request;
  const session = node.restorableSession;
  if (session === undefined || session.jwk === undefined) throw new Error("the profile session has no signing key");
  const profileConfig = await ProfileManager.getProfile(profile);
  // The owner is the profile's own account (did:pkh), never the session key's did:key.
  const ownerDid = profileConfig.ownerDid;
  if (typeof ownerDid !== "string" || !/^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/.test(ownerDid)) {
    throw new CLIError("APPROVAL_REQUEST_CONTEXT_REQUIRED", "This profile has no recorded owner account to check an invitation approval against.", ExitCode.USAGE_ERROR);
  }
  const now = Date.now();
  const accessExpiresAt = new Date(Math.floor(request.accessExpiresAt.getTime() / 1000) * 1000).toISOString();
  const context: ShareInvitationApprovalContext = await pendingInvitationContext(profile, {
    recipientEmail: request.recipientEmail, subjectKind: request.subjectKind, subjectName: request.subjectName, accessExpiresAt,
  }) ?? {
    kind: "share-invitation", version: 1, invitationId: newInvitationId(now), recipientEmail: request.recipientEmail,
    subjectKind: request.subjectKind, subjectName: request.subjectName,
    acceptanceExpiresAt: new Date(Math.floor(Math.min(now + DAY_MS, Date.parse(accessExpiresAt)) / 1000) * 1000).toISOString(), accessExpiresAt,
  };
  const host = (await node.activeNodeIdentity()).origin;
  const key = session.jwk as unknown as Ed25519PrivateJwk;
  const delegation = await acquireApprovalRequest(node.credentialHolderDid, {
    profileName: profile, jwk: session.jwk, host, invitationContext: context, expectedOwner: ownerDid,
    openkeyHost: process.env.TC_OPENKEY_HOST ?? profileConfig.openkeyHost,
    ...(request.onApprovalRequest === undefined ? {} : { onApprovalRequest: request.onApprovalRequest }),
  });
  const grant = invitationGrantOf(delegation, key);
  const entryKey = grant.permissions[0]!;
  const portable: PortableDelegation = {
    cid: delegation.delegationCid, delegationHeader: { Authorization: delegation.delegationHeader.Authorization }, spaceId: delegation.spaceId,
    path: entryKey.path, actions: [...entryKey.actions], resources: [{ service: "encryption", space: "encryption", path: entryKey.path, actions: [...entryKey.actions] }],
    expiry: new Date(grant.expiresAt), delegateDID: delegation.verificationMethod as string, ownerAddress: delegation.address as string,
    chainId: delegation.chainId as number, host, siweProof: { siwe: delegation.siwe as string, signature: delegation.signature as string },
  };
  try {
    await activateValidatedRuntimeDelegation(node, portable, {
      host,
      // What the node ends up holding must be exactly the one pair, again from the signed bytes it parsed itself.
      authorize: (effective) => {
        try {
          return invitationKeyFromGrant(effective, { ownerDid: grant.ownerDid, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, acceptanceExpiresAt: context.acceptanceExpiresAt }) === grant.shareId;
        } catch { return false; }
      },
    });
  } catch (error) {
    throw new CLIError("APPROVAL_RESULT_INVALID", `The invitation approval could not be installed for this profile (${(error as { code?: string }).code ?? "refused"}); no invitation was sent.`, ExitCode.PERMISSION_DENIED);
  }
  // Taking the approval makes it single-use: a send that fails from here on needs a new approval.
  await takeInvitationApproval(profile, delegation);
  return { shareId: grant.shareId };
};
