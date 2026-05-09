---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
---

Introduce `EXPIRY` tiers as the single source of truth for default
delegation lifetimes. Pick a tier, not a number, when adding a new
delegation surface.

The five tiers, exported from `@tinycloud/sdk-core`:

- `EXPIRY.EPHEMERAL_MS` (1h) — auto-refreshable, never user-visible.
- `EXPIRY.SESSION_MS` (7d) — sign-in sessions and runtime grants
  (capped by session anyway).
- `EXPIRY.SHARE_MS` (7d) — share links and ad-hoc third-party
  delegations.
- `EXPIRY.APP_MS` (30d) — manifest-declared installs.
- `EXPIRY.MAX_MS` (10y) — caller-supplied upper bound.

Behavior changes:

- **`SharingService` share-link default: 24h → 7d.** Same direction as
  the runtime-grant default that already shipped at 7d. Callers passing
  explicit expiry are unaffected.
- **`DelegationManager.create()` default: 24h → 7d** when the caller
  omits `expiry`.
- **`SpaceService` server-response fallback: 24h → 7d** when the
  server's delegation response lacks an `expiry` field.
- **`NodeUserAuthorization.sessionExpirationMs` default: 1h → 7d.**
  Fixes a silent inconsistency where direct `NodeUserAuthorization`
  consumers got 1h while `TinyCloudNode` users got 7d.
- **`TinyCloudNode` public-space sub-delegation: 1h** (unchanged value,
  re-tagged as `EPHEMERAL` to make the intent legible — these are
  re-derived transparently on every public-space touch).

Sites unchanged in value but re-pointed at tiered constants:

- `TinyCloudNode.DEFAULT_SESSION_EXPIRATION_MS` → `EXPIRY.SESSION_MS`
- `delegateToHelpers.DEFAULT_DELEGATION_EXPIRY_MS` → `EXPIRY.SESSION_MS`
- `manifest.DEFAULT_EXPIRY` (`"30d"`) — still ms-format string for
  parser compatibility, comment now points at `EXPIRY.APP_MS`.
