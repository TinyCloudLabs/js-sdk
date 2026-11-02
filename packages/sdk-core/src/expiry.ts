/**
 * Default lifetimes for the various delegation shapes the SDK mints.
 *
 * The SDK has many delegation flows (session sign-in, runtime grants,
 * share links, manifest installs, public-space sub-delegations, …) and
 * each one used to pick its own number freehand. That made it hard to
 * tell whether a chosen value was deliberate or copy-pasted, and made
 * silent inconsistencies easy to ship.
 *
 * Every default below answers two questions:
 *  - Who recovers if the delegation leaks? (re-auth, revocation, no one)
 *  - Who is the principal at use time? (issuer, third party)
 *
 * The five tiers fall out of those answers. Pick a tier, not a number,
 * when introducing a new delegation surface.
 *
 * @packageDocumentation
 */

/**
 * Auto-refreshable, never user-visible. The SDK can re-derive these
 * transparently from the active session. Lifetime exists only to bound
 * replay if the wire format leaks.
 *
 * Use for: public-space sub-delegations, internal capability re-derivations.
 */
const EPHEMERAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Short-lived bearer URLs for direct KV reads. Anyone holding the URL can
 * read the object until expiry, so the default is deliberately shorter than
 * delegation-style tiers. Callers can request a different TTL per URL.
 *
 * Use for: KV signed read URLs.
 */
const SIGNED_READ_URL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The user's currently-active sign-in session. Recovery is re-sign-in.
 * Length tracks how long the user/agent is expected to be working
 * without re-prompt.
 *
 * Sized at 30 days so long-running backend services, agents, and other
 * persistent identities re-sign in rarely: every forced re-sign-in is a
 * point where an unattended process can fail. Revocation, not expiry, is
 * the control for cutting off a session early. Delegations minted from a
 * session are still bounded by it (TinyCloud Node enforces child expiry
 * <= parent expiry).
 *
 * Use for: TinyCloudNode session expiry, runtime permission grants
 * (which are capped by the session anyway).
 */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Ad-hoc third-party delegations the caller often forgets to revoke.
 * Default sized so a forgotten share link prunes itself within a week
 * rather than living forever; callers pass longer for known recipients.
 *
 * Use for: SharingService share links, DelegationManager defaults,
 * SpaceService server-response fallback.
 */
const SHARE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Manifest-declared delegations for installed apps. Long enough that
 * monthly re-prompts feel like maintenance, short enough that
 * abandoning an app prunes its access.
 *
 * Use for: manifest `expiry` defaults.
 */
const APP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const EXPIRY = {
  EPHEMERAL_MS,
  SIGNED_READ_URL_MS,
  SESSION_MS,
  SHARE_MS,
  APP_MS,
} as const;

/**
 * The latest expiry a wallet-signed message (a SIWE session or delegation) can
 * carry: 9999-12-31T23:59:59Z. SIWE writes times as RFC 3339 with a four-digit
 * year, and the WASM and the node both refuse a year of 10000 or more.
 */
export const MAX_SIWE_EXPIRY_MS = 253402300799000;

/**
 * Why `expiresAt` cannot be written into a wallet-signed message, or `null` when
 * it can. This is the only upper limit on a lifetime the owner chooses, and it
 * is technical, not policy. An invalid Date, NaN and Infinity are refused too,
 * because `toISOString()` throws a bare `RangeError` on them.
 *
 * The matching limit for tokens signed by the session key lives in
 * `@tinycloud/node-sdk` (`ucanExpiryRefusal`), which is the only place those
 * tokens are minted from.
 */
export function technicalExpiryRefusal(expiresAt: Date | number): string | null {
  // `NaN` (an invalid Date) and `Infinity` fail the comparison too, so they are refused with the same message.
  return Number(expiresAt) <= MAX_SIWE_EXPIRY_MS
    ? null
    : "expiry is not a valid date or is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry";
}

/** Throws the {@link technicalExpiryRefusal} message as an `Error`. */
export function assertExpiryWithinTechnicalLimit(expiresAt: Date | number): void {
  const refusal = technicalExpiryRefusal(expiresAt);
  if (refusal) throw new Error(refusal);
}

export const DEFAULT_SIGNED_READ_URL_EXPIRY_MS = EXPIRY.SIGNED_READ_URL_MS;

export type ExpiryTier = keyof typeof EXPIRY;
