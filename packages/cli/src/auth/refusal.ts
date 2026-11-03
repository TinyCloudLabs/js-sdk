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

/**
 * A ceiling the approval exceeds only against the LOCAL clock (a CLI clock behind OpenKey's makes a lifetime as requested look
 * too long) is not a refusal of the approval: it is kept like AUTH_EXPIRED, so the same command can resume it.
 */
const clockDependent = new WeakSet<object>();
export function markClockDependent(error: unknown): void {
  if (typeof error === "object" && error !== null) clockDependent.add(error);
}

/**
 * OpenKey answered a poll of a request the owner may already have approved with an error that ends the CLI's ability to collect
 * the result (it rejected the requester proof: a CLI clock behind OpenKey's). The CLI never learned whether, or what, was granted.
 */
const maybeGranted = new WeakSet<object>();
export function markMaybeGranted<T>(error: T): T {
  if (typeof error === "object" && error !== null) maybeGranted.add(error);
  return error;
}
export const isMaybeGranted = (error: unknown): boolean => typeof error === "object" && error !== null && maybeGranted.has(error);

/** The notice when the CLI abandons a request OpenKey MAY have approved: nothing is known of the grant, so nothing is claimed. */
export function maybeGrantedNotice(rotation: boolean): string {
  return `OpenKey may already have granted this approval; this CLI did not use it and cannot revoke it; check and revoke at ${REVOKE_URL}.${rotation ? " The key it would belong to was deleted, so it cannot be used. Your current login and its key are unchanged." : ""}`;
}

export function isPermanentRefusal(error: unknown): error is CLIError {
  return error instanceof CLIError && !clockDependent.has(error) && (PERMANENT_REFUSALS.has(error.code) || wasRefusedAfterApproval(error));
}

/**
 * When the grant OpenKey made ends: the `Expiration Time` of the result's own SIWE (the last anchored line). Display only, so an unverified result still says what it claims; no readable line means no date.
 */
export function grantedUntil(delegation: Record<string, unknown> | undefined): string | undefined {
  const siwe = typeof delegation?.siwe === "string" ? delegation.siwe : "";
  const raw = [...siwe.matchAll(/^Expiration Time: (.+)$/gm)].at(-1)?.[1];
  const ms = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A CID is base32 or base58: letters and digits only. A value from an unverified result is never printed or matched otherwise. */
export const isCid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9]{8,128}$/.test(value);

/** The refused delegation's CID (not a secret), from a result or a portable grant; undefined when it does not look like a CID. */
export function delegationCidOf(delegation: Record<string, unknown> | undefined): string | undefined {
  const cid = delegation?.delegationCid ?? delegation?.cid;
  return isCid(cid) ? cid : undefined;
}

const approvalText = (until: string | undefined, atLatest = false): string =>
  `OpenKey granted this approval${until === undefined ? "" : ` ${atLatest ? "at the latest until" : "until"} ${until}`}`;
export const keyDeletedLine = (until?: string, atLatest = false): string =>
  `${approvalText(until, atLatest)}, but this CLI did not use it and its key was deleted, so it cannot be used. You can also remove it at account.tinycloud.xyz.`;
export const keyKeptLine = (until?: string): string =>
  `${approvalText(until)} and the key it belongs to still exists on this device (other grants may use it). Revoke it at account.tinycloud.xyz.`;
const keyNotDeletedLine = (until: string | undefined, reason: string): string =>
  `${approvalText(until)}, but this CLI did not use it and could not delete its key (${reason}). Revoke it at account.tinycloud.xyz.`;

export type KeyOutcome = { readonly kind: "deleted" } | { readonly kind: "kept" } | { readonly kind: "failed"; readonly reason: string };

/**
 * The one plain notice for a refused approval, on stderr: which delegation it was (when known), until when OpenKey granted it,
 * what became of its key, and that this CLI cannot revoke it. Never holds the delegation header, the SIWE signature, a code or
 * a key.
 */
export function refusalNotice(delegation: Record<string, unknown> | undefined, key: KeyOutcome, rotation = false, latestEnd?: string): string {
  // The result was never handed back, so its own date is unknown: the latest it can end is the request's bound (`latestEnd`).
  const known = grantedUntil(delegation);
  const until = known ?? latestEnd;
  const atLatest = known === undefined && latestEnd !== undefined;
  const cid = delegationCidOf(delegation);
  const live = until === undefined ? "It stays live" : `It stays live until ${until}`;
  const revoke = `this CLI cannot revoke it; revoke it at ${REVOKE_URL}.`;
  // For a rotation "its key" is the staged new key; the key and login in use were never touched, and the notice says so.
  const unchanged = rotation ? " Your current login and its key are unchanged." : "";
  const body = key.kind === "deleted" ? `${keyDeletedLine(until, atLatest)}${unchanged} This CLI cannot revoke it; revoke it at ${REVOKE_URL}.`
    : key.kind === "kept" ? `${keyKeptLine(until)}${unchanged} ${live} unless revoked, and ${revoke}`
      : `${keyNotDeletedLine(until, key.reason)}${unchanged} ${live} unless revoked, and ${revoke}`;
  return `${cid === undefined ? "" : `Refused delegation: ${cid}. `}${body}`;
}
