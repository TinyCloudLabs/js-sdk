---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
"@tinycloud/server": patch
---

Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text.

- **Typed classification.** The new `authorizationVerdictOf(error)` reads a 4xx/5xx `status`, `statusCode` or `meta.status`, or the `AUTH_UNAUTHORIZED` code. It follows the `cause` chain from the outside in and skips success statuses. The outermost error status decides.
- **Session refresh.** `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. To keep the typed status, throw the `ServiceError` or an `Error` with it as `cause`.
- **Untyped errors.** Message matching is now only a fallback. In that fallback, a 401 or 403 counts only in explicit status positions: `: 403 `, `HTTP 401`, `(403)` or a leading `403 `. Numbers inside paths, ids, ports or byte counts no longer count.
- **KV messages.** KV 401/403 errors now read `<operation>: <status> - <server text>`. They keep the server text, and `meta` is unchanged.
- **Account-registry sync.** The wrappers keep the service error or host result as `cause`. These wrappers are `applications.register`, `spaces.syncAccessible`, owned-space activation, owned-space hosting and post-create re-activation. A 401 or 403 therefore stops after one request, even when the body is `Forbidden` or empty, and every wrapper message carries the status.
- **New method.** `NodeUserAuthorization.hostOwnedSpaceResult()` returns the full `SpaceHostResult`. `hostOwnedSpace()` still returns `boolean`.
