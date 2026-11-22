---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---

A renewal lease issued to a renewer the node no longer advertises fails with the coded error `RENEWAL_RENEWER_CHANGED` (`RenewalRenewerChangedError` from `@tinycloud/sdk-core/delegations/renewal`). Lease admission, renewal history checks and node-sdk's renewal restore throw it, and `restoreStoredSession` reads it as an expired session (`AUTH_EXPIRED`), so callers ask the owner for a new approval. The CLI matches the code, not the message.

Details: TC-3617
