import type { SenderShareRecord, SenderShareRecordStorage } from "./history.js";

/**
 * One root of an addressed share after `revokeShare`. A `left-live` root is
 * only ever the policy-authority root, whose audience is a policy digest DID
 * with no key: it cannot authorize anything once the enforcement root is
 * revoked, and it lapses at `expiresAt`.
 */
export type ShareRootRevocationState =
  | { readonly rootCid: string; readonly targetRole: "policy-authority" | "policy-enforcement"; readonly state: "revoked" }
  | { readonly rootCid: string; readonly targetRole: "policy-authority"; readonly state: "left-live"; readonly expiresAt: string };

export type ShareRevocationResult =
  | {
    readonly state: "revoked";
    readonly target: "bearer" | "recipientDid" | "email" | "emailDomain";
    /** The bearer delegation; for an addressed share its enforcement root (its policy root when the record has no enforcement root). */
    readonly delegationCid: string;
    /** Addressed shares: every root the share created, with what this revocation did to it. Recipient access has ended. */
    readonly roots?: readonly ShareRootRevocationState[];
    readonly revokedAt: string;
  }
  | { readonly state: "unsupported"; readonly target: string; readonly reason: string; readonly code: "unsupported-target" };

export interface SharePolicyRootRevocation {
  readonly rootCid: string;
  readonly targetRole: "policy-authority" | "policy-enforcement";
  readonly ownerDid: string;
  readonly nodeOrigin: string;
  readonly nodeAudience: string;
}

export interface ShareRevocationAdapter {
  /**
   * Native bearer authority uses the node's ordinary revocation endpoint. The
   * record carries the stored link, whose delegation names its issuer.
   */
  revokeDelegation?(input: { readonly delegationCid: string; readonly scope: "direct" | "ancestor"; readonly record: SenderShareRecord }): Promise<void>;
  /**
   * Addressed Policy/v3 authority uses the Node's signed root-revocation
   * endpoint. The Node checks that root for active sessions, new admission,
   * and delivery; this is not a separate share authority plane. It resolves
   * when the root is revoked, including when the Node already holds a
   * revocation for it, and rejects otherwise. For the policy-authority root
   * only, it may resolve `"left-live"` instead of revoking it (for example
   * when revoking it would cost the owner another wallet approval).
   */
  revokePolicyRoot?(input: SharePolicyRootRevocation): Promise<void | "left-live">;
}

/** A root an addressed revocation did not end. */
export interface ShareRootRevocationFailure {
  readonly rootCid: string;
  readonly targetRole: SharePolicyRootRevocation["targetRole"];
  readonly error: unknown;
}

/**
 * An addressed revocation did not finish: a root failed, or only the
 * policy-authority root was dealt with. `revoked` names the roots that were
 * revoked; if it is not empty, recipient access has ended, since every
 * recipient request needs both roots. The share record is not marked
 * revoked, so the caller can retry.
 */
export class ShareRevocationIncompleteError extends Error {
  constructor(readonly revoked: readonly string[], readonly failed: readonly ShareRootRevocationFailure[]) {
    super(`share revocation incomplete: ${failed.map((failure) => failure.targetRole).join(", ")} not revoked`);
    this.name = "ShareRevocationIncompleteError";
  }
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

/**
 * Revoke a share. A bearer share revokes the delegation `scope` selects. An
 * addressed share asks the adapter for every root it created, the
 * enforcement root and then the policy root, whatever `scope` says; the
 * adapter may leave the keyless policy-authority root live. It succeeds only
 * when no root failed and at least one was revoked (so recipient access has
 * ended); otherwise it throws {@link ShareRevocationIncompleteError} after
 * trying every root.
 */
export async function revokeShare(input: {
  readonly record: SenderShareRecord;
  /** Optional durable store; successful revocation is persisted before return. */
  readonly records?: SenderShareRecordStorage;
  readonly adapter?: ShareRevocationAdapter;
  /** Bearer shares only. */
  readonly scope?: "direct" | "ancestor";
  readonly now?: () => Date;
}): Promise<ShareRevocationResult> {
  const target = targetKind(input.record);
  if (input.adapter === undefined) return { state: "unsupported", target, reason: "node revocation authority is required", code: "unsupported-target" };
  let delegationCid: string;
  let roots: ShareRootRevocationState[] | undefined;
  if (target === "bearer") {
    const scope = input.scope ?? "direct";
    const selected = scope === "ancestor" ? input.record.ownerDelegationCid : input.record.enforcementDelegationCid;
    if (selected === undefined) return { state: "unsupported", target, reason: "share has no node-enforced delegation receipt", code: "unsupported-target" };
    if (input.adapter.revokeDelegation === undefined) return { state: "unsupported", target, reason: "native delegation revocation authority is required", code: "unsupported-target" };
    await input.adapter.revokeDelegation({ delegationCid: selected, scope, record: input.record });
    delegationCid = selected;
  } else {
    const requests = ([
      [input.record.enforcementDelegationCid, "policy-enforcement"],
      [input.record.ownerDelegationCid, "policy-authority"],
    ] as const).flatMap(([rootCid, targetRole]) => rootCid === undefined ? [] : [{ rootCid, targetRole }]);
    const first = requests[0];
    if (first === undefined) return { state: "unsupported", target, reason: "share has no node-enforced delegation receipt", code: "unsupported-target" };
    const ownerDid = input.record.ownerDid;
    if (ownerDid === undefined) return { state: "unsupported", target, reason: "share has no Policy/v3 owner receipt", code: "unsupported-target" };
    const revokePolicyRoot = input.adapter.revokePolicyRoot;
    if (revokePolicyRoot === undefined) return { state: "unsupported", target, reason: "Policy/v3 root revocation authority is required", code: "unsupported-target" };
    const nodeAudience = policyNodeAudience(input.record);
    roots = [];
    const failed: ShareRootRevocationFailure[] = [];
    for (const request of requests) {
      try {
        // Untyped adapters: only `undefined` means revoked, and only `"left-live"` may skip a root.
        const outcome: unknown = await revokePolicyRoot({ ...request, ownerDid, nodeOrigin: input.record.target.origin, nodeAudience });
        if (outcome === "left-live") {
          // Only the keyless policy-authority root may stay; an enforcement root left live is a failure.
          if (request.targetRole !== "policy-authority") throw new Error("the enforcement root cannot be left live");
          roots.push({ rootCid: request.rootCid, targetRole: "policy-authority", state: "left-live", expiresAt: input.record.expiresAt });
        } else if (outcome === undefined) {
          roots.push({ ...request, state: "revoked" });
        } else {
          throw new Error("root revocation returned an unknown outcome");
        }
      } catch (error) {
        failed.push({ ...request, error });
      }
    }
    const revoked = roots.flatMap((root) => root.state === "revoked" ? [root.rootCid] : []);
    if (failed.length > 0 || revoked.length === 0) {
      throw new ShareRevocationIncompleteError(revoked, failed.length > 0 ? failed : roots.map((root) => ({ rootCid: root.rootCid, targetRole: root.targetRole, error: new Error("no root was revoked") })));
    }
    delegationCid = first.rootCid;
  }
  // Revoking again is idempotent at the node; the first revocation time stands.
  let revokedAt = input.record.revokedAt ?? (input.now?.() ?? new Date()).toISOString();
  if (input.records?.update !== undefined) {
    const updated = await input.records.update(input.record.shareId, (record) => ({ ...record, revokedAt: record.revokedAt ?? revokedAt }));
    revokedAt = updated?.revokedAt ?? revokedAt;
  } else if (input.records !== undefined) {
    // Without an atomic update, read the latest record first. A concurrent
    // writer between this read and put can still win; stores that need that
    // guarantee implement `update`.
    const latest = await input.records.get(input.record.shareId);
    revokedAt = latest?.revokedAt ?? revokedAt;
    await input.records.put({ ...(latest ?? input.record), revokedAt });
  }
  return { state: "revoked", target: target as "bearer" | "recipientDid" | "email" | "emailDomain", delegationCid, ...(roots === undefined ? {} : { roots }), revokedAt };
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
