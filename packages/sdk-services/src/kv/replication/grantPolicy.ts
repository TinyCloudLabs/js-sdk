/**
 * Grant lifetime policy (TC-858 plan §6, CONTRACT.md §3). Pure functions over epoch
 * milliseconds. Types and constants come from the shared contract; this file only implements them.
 */
import { CONSENT_WINDOW_MS, RENEW_BELOW_FRACTION } from "./contractConstants";
import type {
  ConsentDeadlineMs,
  EffectiveGrantExpiry,
  MintRemainingMs,
  NeedsSilentRenewal,
} from "./grantPolicyTypes";

export const consentDeadlineMs: ConsentDeadlineMs = (anchor) => anchor.at + CONSENT_WINDOW_MS;

export const effectiveGrantExpiry: EffectiveGrantExpiry = ({
  signedExpiresAt,
  installedAt,
  grantTtlMs,
  consentDeadline,
}) => {
  const ttlBound = installedAt + grantTtlMs;
  const localBound = Math.min(ttlBound, consentDeadline);
  return signedExpiresAt === null ? localBound : Math.min(signedExpiresAt, localBound);
};

export const mintRemainingMs: MintRemainingMs = ({ now, grantTtlMs, consentDeadline }) =>
  Math.min(grantTtlMs, consentDeadline - now);

export const needsSilentRenewal: NeedsSilentRenewal = ({ now, installedAt, effectiveExpiresAt, consentDeadline }) => {
  if (now >= consentDeadline) return false;
  const remaining = effectiveExpiresAt - now;
  const lifetime = effectiveExpiresAt - installedAt;
  return remaining < lifetime * RENEW_BELOW_FRACTION;
};
