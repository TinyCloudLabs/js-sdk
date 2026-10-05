---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

TC-628: Storage status, one `storage.full` event, and no doomed writes on read paths.

- Storage rejections read the node's JSON 402/413 body. `meta.usedBytes`/`meta.limitBytes` still describe the space, and `meta.account` carries `{ usedBytes, limitBytes, plan }` for the whole account when the node sends it. The old plain-text body still parses. New export `parseStorageRejection`.
- `tc.on("storage.full", handler)` on `TinyCloudNode` and `TinyCloudWeb` fires once, on the first write any service has rejected for storage, with the code, the space numbers and `account`. The event also goes through the service context's `emit` as `storage.full` (`TelemetryEvents.STORAGE_FULL`). It fires again only after `storage.status()` reports room.
- `tc.storage.status({ space? })` reads usage and plan from the node (`tinycloud.space/info`, TC-626) and returns `{ usedBytes, limitBytes, account, plan, state, manageUrl }`. `state` is `ok`, `nearly_full` (≥ 90%) or `full`, taken from the account totals when known, and `limitBytes: null` means unlimited. It needs a session granted `tinycloud.space/info` on that space. Default sessions do not request it yet, so without the grant it returns `PERMISSION_DENIED` and sends no request. A node without the usage read returns the new `STORAGE_STATUS_UNAVAILABLE`.
- Once storage is known full, `spaces.list()` no longer registers each listed space, and sign-in skips the bootstrap repair (`bootstrapStatus.reason: "storage-full"`), whose writes would only be refused again.
- Removed: `TinyCloudQuota`, `QuotaConfig`, `QuotaStatus` and `StorageQuotaInfo`. Nothing in the SDK called them. Use `storage.status()` and `on("storage.full")` instead. This breaks code that imported them.
- New exports: `StorageFullMonitor`, `parseStorageStatus`, `storageUsageState`, `STORAGE_MANAGE_URL`, `STORAGE_NEARLY_FULL_RATIO` and the `StorageStatus`/`StorageFullEvent` types.
