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
 * The latest expiry a token signed by the session key (`delegateTo`, agent and
 * share delegations) can carry: 2255-06-05T23:47:34Z, floored to the second.
 * The WASM's UCAN timestamps are exact to the microsecond in a double, which
 * stops there. A session itself may still be signed to 9999.
 */
export const MAX_UCAN_EXPIRY_MS = 9007199254000;

export type TechnicalExpiryKind = "siwe" | "ucan";

/**
 * Why `expiresAt` cannot be written into a message of this kind, or `null` when
 * it can. These are the only upper limits on a lifetime the owner chooses; they
 * are technical, not policy. An invalid Date, NaN, Infinity and an instant before
 * 1970 are refused too, because `toISOString()` throws a bare `RangeError` on the
 * first three and writes a negative year the WASM cannot read for the last.
 */
export function technicalExpiryRefusal(expiresAt: Date | number, kind: TechnicalExpiryKind): string | null {
  const ms = Number(expiresAt);
  const siwe = kind === "siwe";
  const last = siwe ? "9999-12-31" : "2255-06-05";
  if (!Number.isFinite(ms) || ms < 0) return `expiry is not a valid date or is too far away to hold; choose one before ${last}`;
  if (ms <= (siwe ? MAX_SIWE_EXPIRY_MS : MAX_UCAN_EXPIRY_MS)) return null;
  return `expiry is later than ${last}, ${
    siwe
      ? "the latest date a TinyCloud signed message can carry"
      : "the latest date an agent or share delegation can carry (UCAN limit); a delegation signed by the wallet (delegateTo with forceWalletSign: true) can go to 9999-12-31"
  }; choose an earlier expiry`;
}

/** Throws the {@link technicalExpiryRefusal} message as an `Error`. */
export function assertExpiryWithinTechnicalLimit(expiresAt: Date | number, kind: TechnicalExpiryKind): void {
  const refusal = technicalExpiryRefusal(expiresAt, kind);
  if (refusal) throw new Error(refusal);
}

export const DEFAULT_SIGNED_READ_URL_EXPIRY_MS = EXPIRY.SIGNED_READ_URL_MS;

export type ExpiryTier = keyof typeof EXPIRY;
