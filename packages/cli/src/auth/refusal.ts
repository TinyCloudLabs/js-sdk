import { CLIError } from "../output/errors.js";

/** Where an owner revokes a delegation. The CLI cannot: a login's approved set carries no `tinycloud.delegation/revoke`. */
export const REVOKE_URL = "https://account.tinycloud.xyz/delegations";

/**
 * Codes that say "OpenKey granted this, and the CLI refuses it for good": raised only by checks of the owner's signed
 * result, so the delegation exists and nothing here will ever use it. Not in the set, on purpose: AUTH_EXPIRED (a clock
 * or an already-ended approval) and the commit-time refusals (SESSION_IN_USE, PROFILE_CHANGED_DURING_LOGIN, REPLICA_GATED,
 * PROFILE_LOCK_TIMEOUT). The resume design keeps a saved approval for those so the same command can finish it.
 */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set([
  "OPENKEY_OWNER_MISMATCH",
  "OPENKEY_SCOPE_MISMATCH",
  "OPENKEY_GRANT_BROADENED",
  "OPENKEY_APPROVAL_NARROWER",
  "OPENKEY_PROOF_INVALID",
  "OPENKEY_EXPIRY_EXCEEDED",
  "OPENKEY_SESSION_MISMATCH",
  "RAW_RECAP_RESOURCE_UNSUPPORTED",
  "DEVICE_AUTH_BINDING_MISMATCH",
]);

/**
 * Refusals raised where the owner's result had already been opened (the pending-request fetch, the device poll). They are
 * marked there, with the result when it could be read, so a caller that never saw the result can still tell the refusal from
 * one raised BEFORE any approval (a pinned-owner conflict, an unusable request), which owes the owner no notice.
 */
const refusedResults = new WeakMap<object, Record<string, unknown> | undefined>();
export function carryRefusedDelegation(error: unknown, delegation: unknown): void {
  if (typeof error === "object" && error !== null) {
    refusedResults.set(error, typeof delegation === "object" && delegation !== null ? delegation as Record<string, unknown> : undefined);
  }
}
export const wasRefusedAfterApproval = (error: unknown): boolean => typeof error === "object" && error !== null && refusedResults.has(error);
export const carriedDelegation = (error: unknown): Record<string, unknown> | undefined =>
  typeof error === "object" && error !== null ? refusedResults.get(error) : undefined;

export function isPermanentRefusal(error: unknown): error is CLIError {
  return error instanceof CLIError && (PERMANENT_REFUSALS.has(error.code) || wasRefusedAfterApproval(error));
}

/**
 * When the grant OpenKey made ends: the `Expiration Time` of the result's own SIWE (the last anchored line, as the saved
 * session reads it). Display only, so an unverified result still says what it claims; no readable line means no date.
 */
export function grantedUntil(delegation: Record<string, unknown> | undefined): string | undefined {
  const siwe = typeof delegation?.siwe === "string" ? delegation.siwe : "";
  const raw = [...siwe.matchAll(/^Expiration Time: (.+)$/gm)].at(-1)?.[1];
  const ms = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The refused delegation's CID (not a secret), from a result or a portable grant. */
export function delegationCidOf(delegation: Record<string, unknown> | undefined): string | undefined {
  const cid = delegation?.delegationCid ?? delegation?.cid;
  return typeof cid === "string" && cid !== "" ? cid : undefined;
}

const approvalText = (until: string | undefined): string => `OpenKey granted this approval${until === undefined ? "" : ` until ${until}`}`;
export const keyDeletedLine = (until?: string): string =>
  `${approvalText(until)}, but this CLI did not use it and its key was deleted, so it cannot be used. You can also remove it at account.tinycloud.xyz.`;
export const keyKeptLine = (until?: string): string =>
  `${approvalText(until)} and the key it belongs to still exists on this device (other grants use it). Revoke it at account.tinycloud.xyz.`;
const keyNotDeletedLine = (until: string | undefined, reason: string): string =>
  `${approvalText(until)}, but this CLI did not use it and could not delete its key (${reason}). Revoke it at account.tinycloud.xyz.`;

export type KeyOutcome = { readonly kind: "deleted" } | { readonly kind: "kept" } | { readonly kind: "failed"; readonly reason: string };

/**
 * The one plain notice for a refused approval, on stderr: which delegation it was (when known), until when OpenKey granted it,
 * what became of its key, and that this CLI cannot revoke it. Never holds the delegation header, the SIWE signature, a code or
 * a key.
 */
export function refusalNotice(delegation: Record<string, unknown> | undefined, key: KeyOutcome): string {
  const until = grantedUntil(delegation);
  const cid = delegationCidOf(delegation);
  const live = until === undefined ? "It stays live" : `It stays live until ${until}`;
  const revoke = `this CLI cannot revoke it; revoke it at ${REVOKE_URL}.`;
  const body = key.kind === "deleted" ? `${keyDeletedLine(until)} This CLI cannot revoke it; revoke it at ${REVOKE_URL}.`
    : key.kind === "kept" ? `${keyKeptLine(until)} ${live} unless revoked, and ${revoke}`
      : `${keyNotDeletedLine(until, key.reason)} ${live} unless revoked, and ${revoke}`;
  return `${cid === undefined ? "" : `Refused delegation: ${cid}. `}${body}`;
}
