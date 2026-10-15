/**
 * Grant lifetime and renewal contract (TC-858 Phase 2, CONTRACT.md §3). Types only; S4 implements
 * these signatures in `grantPolicy.ts` using the constants in `contractConstants.ts`.
 * All instants are milliseconds since epoch; all durations are milliseconds.
 */

/** Where the consent anchor came from, in fallback order. */
export type ReplicaConsentSource =
  /** SIWE `issuedAt` of the sign-in that granted replication. */
  | "siwe"
  /** Compact delegated session: the delegation's `iat`. */
  | "delegation_iat"
  /** Compact delegated session without `iat`: its `nbf`. */
  | "delegation_nbf"
  /** Neither: the persisted time this identity's first grant was installed (storage-owned). */
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
   * From `ReplicationAuthority.consentAnchor()`, clamped. Null means the session has neither SIWE
   * nor delegation `iat`/`nbf`; storage then uses its persisted first-install time (source
   * `first_install`), keyed by identity, persisted on the first install, surviving partition
   * reset, purge and reinstall, and cleared only by `deny`.
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
