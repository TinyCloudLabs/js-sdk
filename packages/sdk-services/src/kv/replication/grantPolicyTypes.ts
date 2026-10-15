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

export interface ReplicaConsentAnchor {
  at: number;
  source: ReplicaConsentSource;
}

/**
 * Policy the controller passes to storage in `KVReplicaSpec.grantPolicy`. Storage stores the
 * resulting effective expiry with the installed grant and recomputes it at open.
 */
export interface ReplicaGrantPolicy {
  /** Validated: 0 < grantTtlMs ≤ MAX_GRANT_TTL_MS. */
  grantTtlMs: number;
  /**
   * From `ReplicationAuthority.consentAnchor()`. Null means the session has neither SIWE nor
   * delegation `iat`/`nbf`; storage then uses its persisted first-install time (source
   * `first_install`), persisting it on the first install.
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
 * True when online-renewal should run: remaining = effectiveExpiresAt − now is below
 * RENEW_BELOW_FRACTION × (effectiveExpiresAt − installedAt), and now < consentDeadline.
 * Checked on a timer, before each sync, and at open.
 */
export type NeedsSilentRenewal = (input: {
  now: number;
  installedAt: number;
  effectiveExpiresAt: number;
  consentDeadline: number;
}) => boolean;
