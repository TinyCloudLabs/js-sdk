---
"@tinycloud/web-sdk": minor
---

`@tinycloud/web-sdk/credentials` exports two more held-credential functions. `probeHeldStoreAccess({ kv, ownerDid })` makes one `kv.list` of the account's `v1/held/` prefix and nothing else (no cursor, no read, no write): it resolves when the list is ok, throws `PERMISSION_DENIED` (the same text as the read functions) for a typed kv 401 or 403, and `OFFLINE` for any other failure; it checks list access only, so a session with list but not get passes it and fails later on get. `deleteHeldCredential({ kv, ownerDid, recordId })` (already built and tested in the held store, now public) deletes one record and returns `true`, `false` for a failed delete that is not a permission failure, or throws `PERMISSION_DENIED` for a delete the session may not make; it needs `kv del` on `v1/held/`. Both refuse a non-mainnet owner (`ACTIVE_SESSION_REQUIRED`) before any kv call. `pruneHeldCredentials` is not exported. `CREDENTIALS.md` documents both.

Details: TC-1454
