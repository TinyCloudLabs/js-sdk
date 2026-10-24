import type { AccountDelegationRecord } from "@tinycloud/sdk-core";

import type { DelegationGroup, DelegationRow } from "../data";

export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * `this-app`: granted, delegate is the current session DID.
 * `to-others`: granted, delegate is another DID.
 * `received`: direction is received (checked first, so a received record whose
 * delegate is this session still shows under received).
 */
export function delegationGroup(
  record: Pick<AccountDelegationRecord, "direction" | "delegateDid">,
  sessionDid: string,
): DelegationGroup {
  if (record.direction === "received") return "received";
  return record.delegateDid === sessionDid ? "this-app" : "to-others";
}

/** True only for a future `expiresAt` within 24 h of `now`. Expired records are not "expiring". */
export function isExpiringSoon(expiresAt: Date | null, now: number): boolean {
  if (!expiresAt) return false;
  const remaining = expiresAt.getTime() - now;
  return remaining > 0 && remaining <= EXPIRING_SOON_MS;
}

export function shortDid(did: string): string {
  return did.length <= 22 ? did : `${did.slice(0, 14)}…${did.slice(-6)}`;
}

export function toDelegationRow(
  record: AccountDelegationRecord,
  sessionDid: string,
  now: number,
): DelegationRow {
  return {
    source: "real",
    cid: record.cid,
    direction: record.direction,
    status: record.status,
    group: delegationGroup(record, sessionDid),
    label: { text: shortDid(record.delegateDid), source: "derived" },
    delegatorDid: record.delegatorDid,
    delegateDid: record.delegateDid,
    resources: record.resources.map((r) => ({ resource: r.resource, actions: r.actions })),
    parents: record.parents,
    issuedAt: record.issuedAt,
    notBefore: record.notBefore,
    expiresAt: record.expiresAt,
    expiringSoon: isExpiringSoon(record.expiresAt, now),
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.revokedBy !== undefined ? { revokedBy: record.revokedBy } : {}),
    ...(record.revokedAncestorCid !== undefined
      ? { revokedAncestorCid: record.revokedAncestorCid }
      : {}),
  };
}
