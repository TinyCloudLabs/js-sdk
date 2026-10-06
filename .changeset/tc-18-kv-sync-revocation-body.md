---
"@tinycloud/sdk-services": patch
---

`KVService.changes()` maps a 401 to `AUTH_DELEGATION_REVOKED` / `AUTH_DELEGATION_ANCESTOR_REVOKED` only when the whole response body is the node's revocation error (`delegation-revoked: <cid>`, or `delegation-ancestor-revoked: ancestor=<cid> invoked=<cid>`, optionally prefixed `Invalid invocation: `). Before, any 401 whose text contained `delegation-revoked`, such as `Unauthorized Action` for a prefix with that name, was reported as a revocation; it is now `AUTH_UNAUTHORIZED`.
