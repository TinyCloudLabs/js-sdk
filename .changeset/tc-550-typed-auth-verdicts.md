---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/server": patch
---

Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text. New `authorizationVerdictOf(error)` reads `status`, `statusCode` or `meta.status` (401 or 403), or the `AUTH_UNAUTHORIZED` code, and follows the `cause` chain. `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. The account-registry sync wrappers now keep the service error as `cause`, so a 401 or 403 stops after one request even when the body is `Forbidden` or empty. Message matching is now only a fallback for untyped errors. In that fallback, an explicit `401` or `403` in the text decides before the session wording does. Error messages are unchanged.
