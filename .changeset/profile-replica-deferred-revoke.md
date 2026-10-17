---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
---

sdk-services adds the Node/CLI profile-facade contract types for deferred revoke and exact-inventory logout markers: `ProfileReplicaPurge`, `ProfileReplicaLogoutPending` (with a v1 `deniedEpoch`), `ProfileReplicaRemoteLogoutState`, `ProfileReplicaPreflight` and the inventory identity types. A new `typecheck:contract` script compiles their type assertions. CONTRACT.md specifies the logout behaviour the CLI logout implementation will deliver, including deny-first ordering, completion of an interrupted denial and the two-command inventory approval. This release ships types and specification only; no runtime behaviour changes, and browser lifecycle contracts are unchanged.

node-sdk's `ProfileReplicaPurge` and `ProfileReplicaDeferredToken` are now derived from those contract types (the subset node-sdk implements), with the same shape as before.
