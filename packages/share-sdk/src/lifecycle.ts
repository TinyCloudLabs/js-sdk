import type { SenderShareRecord, SenderShareRecordStorage } from "./history.js";

export type ShareRevocationResult =
  | { readonly state: "revoked"; readonly target: "recipientDid" | "email" | "emailDomain"; readonly delegationCid: string; readonly revokedAt: string }
  | { readonly state: "retention-only"; readonly target: "bearer"; readonly reason: "bearer-capability-cannot-be-revoked" }
  | { readonly state: "unsupported"; readonly target: string; readonly reason: string };

export interface ShareRevocationAdapter {
  revokeDelegation(input: { readonly delegationCid: string; readonly scope: "direct" | "ancestor" }): Promise<void>;
}

function targetKind(record: SenderShareRecord): string {
  if (record.targetKind !== undefined) return record.targetKind;
  return record.recipientMatcher.kind === "exactEmail" ? "email" : record.recipientMatcher.kind === "emailDomain" ? "emailDomain" : record.recipientMatcher.kind === "recipientDid" ? "recipientDid" : "bearer";
}

/** Report retention for bearer shares; only node-enforced targets are revokeable. */
export async function revokeShare(input: {
  readonly record: SenderShareRecord;
  readonly adapter?: ShareRevocationAdapter;
  readonly scope?: "direct" | "ancestor";
  readonly now?: () => Date;
}): Promise<ShareRevocationResult> {
  const target = targetKind(input.record);
  if (target === "bearer") return { state: "retention-only", target, reason: "bearer-capability-cannot-be-revoked" };
  if (input.adapter === undefined) return { state: "unsupported", target, reason: "node revocation authority is required" };
  const scope = input.scope ?? "direct";
  const delegationCid = scope === "ancestor" ? input.record.ownerDelegationCid : input.record.enforcementDelegationCid;
  await input.adapter.revokeDelegation({ delegationCid, scope });
  return { state: "revoked", target: target as "recipientDid" | "email" | "emailDomain", delegationCid, revokedAt: (input.now?.() ?? new Date()).toISOString() };
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
  return {
    shareId: record.shareId,
    target: matcher.kind === "exactEmail" ? "email" : matcher.kind === "emailDomain" ? "email-domain" : matcher.kind === "recipientDid" ? "recipient-did" : "bearer",
    ...(matcher.kind === "exactEmail" ? { recipient: matcher.value } : matcher.kind === "emailDomain" ? { recipient: `*@${matcher.value}` } : matcher.kind === "recipientDid" ? { recipient: matcher.value } : {}),
    expiresAt: record.expiresAt,
    revoked: record.revokedAt !== undefined,
    ...(revealLink && link === undefined ? {} : revealLink && link !== undefined ? { link } : {}),
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
