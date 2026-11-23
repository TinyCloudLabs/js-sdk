---
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

A replica reads a revoked grant from the node's JSON refusal (`{"code": "delegation_revoked", "error": "delegation-revoked: <cid>"}`, sent by nodes 1.25.17 and later) as well as from the plain-text refusal of earlier nodes. A sync or a read under a revoked grant raises `GRANT_REVOKED`, and the replica clears its local copy. `KVService.changes` reports the JSON refusal as `AUTH_DELEGATION_REVOKED` or `AUTH_DELEGATION_ANCESTOR_REVOKED`. Only the whole envelope is opened: a body whose code is not a revocation code, or whose `error` is not exactly the node's revocation text, is `GRANT_UNAUTHORIZED` (replica) or `AUTH_UNAUTHORIZED` (`KVService`).

Details: TC-3947
