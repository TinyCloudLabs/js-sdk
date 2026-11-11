import { randomBytes } from "node:crypto";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { signerFromJwk, type Ed25519PrivateJwk, type ShareInvitationApprovalContext } from "@tinycloud/share-envelope/links";
import { acquireApprovalRequest, pendingInvitationContext, takeInvitationApproval } from "../auth/approval-request.js";
import { invitationKeyFromGrant } from "../auth/invitation-key-grant.js";
import { verifySignedSession } from "../auth/scoped-login.js";
import { ProfileManager } from "../config/profiles.js";

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

/** The one key an approved invitation may use: its id comes from the signed grant, and only these two operations use it. */
export interface EmailInviteKey {
  shareId: string;
  keyNode: Pick<TinyCloudNode, "keys" | "encryption">;
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
 * Ask the owner for one approval for this invitation's Share key, wait for it, verify the signed grant and return a node
 * that holds exactly that key. Nothing is created before the approval. A rerun while the approval is open continues the
 * same request; the approval can be taken once.
 */
export const approveEmailInviteKey: EmailInviteApprover = async (request) => {
  const { node, profile } = request;
  const session = node.restorableSession;
  if (session === undefined || session.jwk === undefined) throw new Error("the profile session has no signing key");
  const now = Date.now();
  const profileConfig = await ProfileManager.getProfile(profile);
  const context: ShareInvitationApprovalContext = await pendingInvitationContext(profile, { recipientEmail: request.recipientEmail, subjectName: request.subjectName }) ?? (() => {
    const acceptance = new Date(Math.floor(Math.min(now + DAY_MS, request.accessExpiresAt.getTime()) / 1000) * 1000).toISOString();
    return {
      kind: "share-invitation", version: 1, invitationId: newInvitationId(now), recipientEmail: request.recipientEmail,
      subjectKind: request.subjectKind, subjectName: request.subjectName,
      acceptanceExpiresAt: acceptance, accessExpiresAt: new Date(Math.floor(request.accessExpiresAt.getTime() / 1000) * 1000).toISOString(),
    };
  })();
  const host = (await node.activeNodeIdentity()).origin;
  const delegation = await acquireApprovalRequest(node.credentialHolderDid, {
    profileName: profile, jwk: session.jwk, host, invitationContext: context, expectedOwner: node.credentialHolderDid,
    openkeyHost: process.env.TC_OPENKEY_HOST ?? profileConfig.openkeyHost,
    ...(request.onApprovalRequest === undefined ? {} : { onApprovalRequest: request.onApprovalRequest }),
  });
  const signed = verifySignedSession(delegation, session.jwk, signerFromJwk(session.jwk as unknown as Ed25519PrivateJwk).did, {
    expectedOwner: node.credentialHolderDid, purpose: "grant",
  });
  const shareId = invitationKeyFromGrant(signed.permissions, { ownerDid: signed.ownerDid, expiresAt: signed.expiresAt, acceptanceExpiresAt: context.acceptanceExpiresAt });
  // Taking the approval first makes it single-use: a send that fails from here on needs a new approval.
  await takeInvitationApproval(profile, delegation);
  const keyNode = new TinyCloudNode({ host });
  await keyNode.restoreSession({
    delegationHeader: delegation.delegationHeader, delegationCid: delegation.delegationCid, spaceId: delegation.spaceId,
    jwk: session.jwk, verificationMethod: delegation.verificationMethod as string, address: delegation.address as string,
    chainId: delegation.chainId as number, siwe: delegation.siwe as string, signature: delegation.signature as string,
  });
  return { shareId, keyNode };
};
