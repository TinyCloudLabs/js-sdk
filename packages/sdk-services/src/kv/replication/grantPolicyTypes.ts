/**
 * Grant lifetime and renewal contract (TC-858 Phase 2, CONTRACT.md §3). Types only; S4 implements
 * these signatures in `grantPolicy.ts` using the constants in `contractConstants.ts`.
 * All instants are milliseconds since epoch; all durations are milliseconds.
 */

/** Where the consent anchor came from, in fallback order. */
export type ReplicaConsentSource =
  /** `issuedAt` of a validated signed SIWE. */
  | "siwe"
  /** `iat` of the independently verified owner-authorizing proof, never a child leaf's new timestamp. */
  | "delegation_iat"
  /** `nbf` of that same owner proof; a leaf signature alone is insufficient. */
  | "delegation_nbf"
  /** Neither: persisted first grant install time, for expiry only; never session establishment. */
  | "first_install";

/**
 * Invariants: `at` is finite milliseconds and clamped to ≤ now by `clampConsentAnchor`. Second-based
 * sources (UCAN `iat`/`nbf`) are converted ×1000 exactly once, at the authority; SIWE `issuedAt`
 * is parsed as an ISO date. Renewals never re-anchor: only a fresh sign-in yields a new anchor.
 */
export interface ReplicaConsentAnchor {
  at: number;
  source: ReplicaConsentSource;
}

/**
 * Returns the anchor with `at` clamped to ≤ now, or null when `at` is not finite (callers then
 * fall back down the source order). S4 implements it as `clampConsentAnchor` in `grantPolicy.ts`.
 */
export type ClampConsentAnchor = (anchor: ReplicaConsentAnchor, now: number) => ReplicaConsentAnchor | null;

/**
 * Policy the controller passes to storage in `KVReplicaSpec.grantPolicy`. Storage stores the
 * resulting effective expiry with the installed grant and recomputes it at open.
 */
export interface ReplicaGrantPolicy {
  /** Validated: 0 < grantTtlMs ≤ MAX_GRANT_TTL_MS. */
  grantTtlMs: number;
  /**
   * From `ReplicationAuthority.consentAnchor()`: validated SIWE `issuedAt`, else the independently
   * verified owner-authorizing proof's signed `iat`, else its `nbf` (never a fresh child leaf
   * minted under an old owner grant). Null means no verified source; storage uses persisted
   * first-install time only to bound grant expiry, never as a freshness proof for a session
   * stamp. That anchor survives partition reset, purge and reinstall and is cleared only by `deny`.
   */
  consentAnchor: ReplicaConsentAnchor | null;
}

export interface EffectiveGrantExpiryInput {
  /** The grant's signed `exp` in ms; null when it has none. */
  signedExpiresAt: number | null;
  installedAt: number;
  grantTtlMs: number;
  /** `consentDeadlineMs(anchor)`. */
  consentDeadline: number;
}

/** effective expiry = min(signed exp, installedAt + grantTtlMs, consentDeadline). */
export type EffectiveGrantExpiry = (input: EffectiveGrantExpiryInput) => number;

/** anchor.at + CONSENT_WINDOW_MS. */
export type ConsentDeadlineMs = (anchor: ReplicaConsentAnchor) => number;

/**
 * Duration passed to `ReplicationAuthority.mint` as `expiryMs`:
 * min(grantTtlMs, consentDeadline − now). The caller MUST NOT mint when the result is ≤ 0.
 */
export type MintRemainingMs = (input: { now: number; grantTtlMs: number; consentDeadline: number }) => number;

/**
 * True when online-renewal should run: remaining = effectiveExpiresAt − now is STRICTLY below
 * RENEW_BELOW_FRACTION × (effectiveExpiresAt − installedAt) (exactly 25% remaining does not
 * renew), and now < consentDeadline. All inputs finite; otherwise false.
 * Checked on a timer, before each sync, and at open.
 */
export type NeedsSilentRenewal = (input: {
  now: number;
  installedAt: number;
  effectiveExpiresAt: number;
  consentDeadline: number;
}) => boolean;
