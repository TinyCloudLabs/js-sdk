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
 * The user's currently-active sign-in session. Recovery is trivial
 * (re-sign-in). Length tracks how long the user/agent is expected to
 * be working without re-prompt.
 *
 * Use for: TinyCloudNode session expiry, runtime permission grants
 * (which are capped by the session anyway).
 */
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

/**
 * Hard ceiling for caller-supplied expiry. Effectively "forever" — the
 * constant exists primarily to guard against integer overflow / typo'd
 * input, not as a security policy lever. Long-lived API-token-style
 * delegations are a first-class use case; revocation is the right
 * control for them.
 */
const MAX_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years

export const EXPIRY = {
  EPHEMERAL_MS,
  SESSION_MS,
  SHARE_MS,
  APP_MS,
  MAX_MS,
} as const;

export type ExpiryTier = keyof typeof EXPIRY;
