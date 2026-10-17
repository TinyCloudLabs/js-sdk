/**
 * Grant lifetime policy (TC-858 plan §6, CONTRACT.md §3). Pure functions over epoch
 * milliseconds. Types and constants come from the shared contract; this file only implements them.
 *
 * Every function fails closed: a non-finite input yields a value that refuses the mint, renewal or
 * read, never a permissive one.
 */
import { CONSENT_WINDOW_MS, MAX_GRANT_TTL_MS, RENEW_BELOW_FRACTION } from "./grantPolicyConstants";
export { MAX_GRANT_TTL_MS } from "./grantPolicyConstants";
import type {
  ConsentDeadlineMs,
  EffectiveGrantExpiry,
  MintRemainingMs,
  NeedsSilentRenewal,
  ReplicaConsentAnchor,
} from "./grantPolicyTypes";

/** An instant that has already passed: nothing is minted, renewed or served against it. */
const EXPIRED = Number.NEGATIVE_INFINITY;

/**
 * Caller contract: clamp the anchor with {@link clampConsentAnchor} first. A non-finite anchor
 * yields an already-passed deadline.
 */
export const consentDeadlineMs: ConsentDeadlineMs = (anchor) =>
  Number.isFinite(anchor.at) ? anchor.at + CONSENT_WINDOW_MS : EXPIRED;

/**
 * Returns the anchor the deadline may be computed from. A non-finite anchor or clock yields
 * `null` (no anchor, so no mint). An anchor dated after `now` is pulled back to `now`, so a
 * future-dated anchor cannot extend the 7 d window.
 */
export const clampConsentAnchor = (
  anchor: ReplicaConsentAnchor | null,
  now: number,
): ReplicaConsentAnchor | null => {
  if (anchor === null || !Number.isFinite(anchor.at) || !Number.isFinite(now)) return null;
  return anchor.at > now ? { at: now, source: anchor.source } : anchor;
};

export const effectiveGrantExpiry: EffectiveGrantExpiry = ({
  signedExpiresAt,
  installedAt,
  grantTtlMs,
  consentDeadline,
}) => {
  const signedValid = signedExpiresAt === null || Number.isFinite(signedExpiresAt);
  if (!signedValid || !Number.isFinite(installedAt) || !Number.isFinite(grantTtlMs) || !Number.isFinite(consentDeadline)) {
    return EXPIRED;
  }
  const ttl = Math.min(grantTtlMs, MAX_GRANT_TTL_MS);
  const localBound = Math.min(installedAt + ttl, consentDeadline);
  return signedExpiresAt === null ? localBound : Math.min(signedExpiresAt, localBound);
};

export const mintRemainingMs: MintRemainingMs = ({ now, grantTtlMs, consentDeadline }) => {
  if (!Number.isFinite(now) || !Number.isFinite(grantTtlMs) || !Number.isFinite(consentDeadline)) return 0;
  return Math.min(Math.min(grantTtlMs, MAX_GRANT_TTL_MS), consentDeadline - now);
};

export const needsSilentRenewal: NeedsSilentRenewal = ({ now, installedAt, effectiveExpiresAt, consentDeadline }) => {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(installedAt) ||
    !Number.isFinite(effectiveExpiresAt) ||
    !Number.isFinite(consentDeadline)
  ) {
    return false;
  }
  if (!(now < consentDeadline)) return false;
  const remaining = effectiveExpiresAt - now;
  const lifetime = effectiveExpiresAt - installedAt;
  return remaining < lifetime * RENEW_BELOW_FRACTION;
};
