import type { SenderShareRecord, SenderShareRecordStorage } from "./history.js";

export type ShareRevocationResult =
  | { readonly state: "revoked"; readonly target: "bearer" | "recipientDid" | "email" | "emailDomain"; readonly delegationCid: string; readonly revokedAt: string }
  | { readonly state: "unsupported"; readonly target: string; readonly reason: string; readonly code: "unsupported-target" };

export interface SharePolicyRootRevocation {
  readonly rootCid: string;
  readonly targetRole: "policy-authority" | "policy-enforcement";
  readonly ownerDid: string;
  readonly nodeOrigin: string;
  readonly nodeAudience: string;
}

export interface ShareRevocationAdapter {
  /** Native bearer authority uses the ordinary node delegation endpoint. */
  revokeDelegation?(input: { readonly delegationCid: string; readonly scope: "direct" | "ancestor" }): Promise<void>;
  /**
   * Addressed Policy/v3 authority uses the Node's signed root-revocation
   * endpoint. The Node checks that root for active sessions, new admission,
   * and delivery; this is not a separate share authority plane.
   */
  revokePolicyRoot?(input: SharePolicyRootRevocation): Promise<void>;
}

function targetKind(record: SenderShareRecord): string {
  if (record.targetKind !== undefined) return record.targetKind;
  return record.recipientMatcher.kind === "exactEmail" ? "email" : record.recipientMatcher.kind === "emailDomain" ? "emailDomain" : record.recipientMatcher.kind === "recipientDid" ? "recipientDid" : "bearer";
}

function policyNodeAudience(record: SenderShareRecord): string {
  const envelope = record.deliveryMaterial?.envelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return record.target.nodeAudience;
  const binding = (envelope as Record<string, unknown>).attestedEnforcerBinding;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return record.target.nodeAudience;
  const nodeAudience = (binding as Record<string, unknown>).nodeAudience;
  return typeof nodeAudience === "string" ? nodeAudience : record.target.nodeAudience;
}

/** Revoke the native bearer delegation or the selected signed Policy/v3 root. */
export async function revokeShare(input: {
  readonly record: SenderShareRecord;
  /** Optional durable store; successful revocation is persisted before return. */
  readonly records?: SenderShareRecordStorage;
  readonly adapter?: ShareRevocationAdapter;
  readonly scope?: "direct" | "ancestor";
  readonly now?: () => Date;
}): Promise<ShareRevocationResult> {
  const target = targetKind(input.record);
  if (input.adapter === undefined) return { state: "unsupported", target, reason: "node revocation authority is required", code: "unsupported-target" };
  const scope = input.scope ?? "direct";
  const delegationCid = scope === "ancestor" ? input.record.ownerDelegationCid : input.record.enforcementDelegationCid;
  if (delegationCid === undefined) return { state: "unsupported", target, reason: "share has no node-enforced delegation receipt", code: "unsupported-target" };
  if (target === "bearer") {
    if (input.adapter.revokeDelegation === undefined) return { state: "unsupported", target, reason: "native delegation revocation authority is required", code: "unsupported-target" };
    await input.adapter.revokeDelegation({ delegationCid, scope });
  } else {
    if (input.record.ownerDid === undefined) return { state: "unsupported", target, reason: "share has no Policy/v3 owner receipt", code: "unsupported-target" };
    if (input.adapter.revokePolicyRoot === undefined) return { state: "unsupported", target, reason: "Policy/v3 root revocation authority is required", code: "unsupported-target" };
    await input.adapter.revokePolicyRoot({
      rootCid: delegationCid,
      targetRole: scope === "ancestor" ? "policy-authority" : "policy-enforcement",
      ownerDid: input.record.ownerDid,
      nodeOrigin: input.record.target.origin,
      nodeAudience: policyNodeAudience(input.record),
    });
  }
  const revokedAt = (input.now?.() ?? new Date()).toISOString();
  if (input.records !== undefined) await input.records.put({ ...input.record, revokedAt });
  return { state: "revoked", target: target as "bearer" | "recipientDid" | "email" | "emailDomain", delegationCid, revokedAt };
}

export interface ShareHistoryView {
  readonly shareId: string;
  readonly target: string;
  readonly recipient?: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly link?: string;
}

function redactRecord(record: SenderShareRecord, revealLink: boolean, link?: string): ShareHistoryView {
  const matcher = record.recipientMatcher;
  const revealedLink = revealLink ? link ?? record.link : undefined;
  return {
    shareId: record.shareId,
    target: matcher.kind === "exactEmail" ? "email" : matcher.kind === "emailDomain" ? "email-domain" : matcher.kind === "recipientDid" ? "recipient-did" : "bearer",
    ...(matcher.kind === "exactEmail" ? { recipient: matcher.value } : matcher.kind === "emailDomain" ? { recipient: `*@${matcher.value}` } : matcher.kind === "recipientDid" ? { recipient: matcher.value } : {}),
    expiresAt: record.expiresAt,
    revoked: record.revokedAt !== undefined,
    ...(revealedLink === undefined ? {} : { link: revealedLink }),
  };
}

export async function listShares(storage: SenderShareRecordStorage): Promise<readonly ShareHistoryView[]> {
  const records = await storage.list();
  return records.map((record) => redactRecord(record, false));
}

export async function showShare(input: { readonly storage: SenderShareRecordStorage; readonly shareId: string; readonly revealLink?: boolean; readonly link?: string }): Promise<ShareHistoryView> {
  const record = await input.storage.get(input.shareId);
  if (record === undefined) throw new Error("share not found");
  return redactRecord(record, input.revealLink === true, input.link);
}
