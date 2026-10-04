---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

TC-619: When the owner's storage is full, reads keep working and writes fail with one typed error.

- `db.migrations.apply()` reads the applied-migration list first. A database that is already up to date is opened with that one read and is never written, so an app that ensures its schema on open still loads on a full space or with a read-only session. The metadata table is created only when it is missing and a migration is pending. Before this, every call wrote a batch first, and a full space failed with `SQL batch failed: 402 - Storage quota exceeded…`.
- KV, SQL and DuckDB report a write rejected for storage with the same codes: `STORAGE_QUOTA_EXCEEDED` (HTTP 402, storage is full) or `STORAGE_LIMIT_REACHED` (HTTP 413, the write is larger than what is left). The message explains that nothing was saved, that reading still works, and what to do. `meta` carries `status`, `usedBytes` and `limitBytes`. A 413 without the node's storage text, such as a proxy's request-size limit, stays `KV_WRITE_FAILED`. Behaviour change: SQL and DuckDB previously reported a 402 as `NETWORK_ERROR`.
- Vault and secrets writes keep the storage code, message and byte counts. Behaviour change: they previously wrapped them in `STORAGE_ERROR`.
- New exports `isStorageFullError(error)`, `STORAGE_FULL_MESSAGE` and `STORAGE_WRITE_TOO_LARGE_MESSAGE` let an app detect "storage full" in one place and switch to a read-only view.
- `account.spaces.list({ preferIndex: true })` still lists accessible spaces when the account space is full. An explicit `account.spaces.syncAccessible()` still reports the failure.
- node-sdk's sign-in registry sync stops after the first storage-full rejection instead of retrying it three times.
