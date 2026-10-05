---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

TC-628: Storage status, one `storage.full` event, and no doomed writes on read paths.

- Storage rejections read the node's JSON 402/413 body. `meta.usedBytes`/`meta.limitBytes` still describe the space, and `meta.account` carries `{ usedBytes, limitBytes, plan }` for the whole account when the node sends it. The old plain-text body still parses. SQL and DuckDB now report a storage 413 (the node's `storage_limit_reached` body or storage text) as `STORAGE_LIMIT_REACHED`, as KV already did; a 413 without it stays `*_RESPONSE_TOO_LARGE`.
- `tc.on("storage.full", handler)` on `TinyCloudNode` and `TinyCloudWeb` fires once, on the first write any service has rejected for storage. The event carries the code, the space numbers, `account` and the rejected `spaceId`. It also goes through the service context's `emit` as `storage.full` (`TelemetryEvents.STORAGE_FULL`). It fires again after `storage.status()` reports room on that account, or after signing in or restoring a session for a different account.
- `tc.storage.status({ space? })` reads usage and plan from the node (`tinycloud.space/info`, TC-626) and returns `{ usedBytes, limitBytes, account, plan, state, manageUrl }`. `state` is `ok`, `nearly_full` (≥ 90%) or `full`, from the account totals when known, and `limitBytes: null` means unlimited. It needs `tinycloud.space/info` on that space, from the session recap or an installed runtime delegation. Default sessions do not request it yet. When the grant cannot be confirmed locally, it returns `PERMISSION_DENIED` and sends no request. A node without the usage read returns the new `STORAGE_STATUS_UNAVAILABLE` code.
- While the signed-in account's storage is known full:
  - `spaces.list()` still lists, but does not register each listed space;
  - sign-in skips the bootstrap repair (`bootstrapStatus.reason: "storage-full"`);
  - sign-in skips the background account registry sync (index ensure, manifest records, space sync).

  These writes would only be refused again. A rejection on another owner's space does not stop them.
- `SpaceServiceConfig` (and `SpaceServiceConfigSchema`) accepts `isStorageFull?: () => boolean`; when it returns true, `list()` skips `onSpaceRegistered`.
- New exports:
  - functions and values: `parseStorageRejection`, `parseStorageStatus`, `storageUsageState`, `StorageFullMonitor`, `STORAGE_MANAGE_URL`, `STORAGE_NEARLY_FULL_RATIO`, and the error code `ErrorCodes.STORAGE_STATUS_UNAVAILABLE`;
  - types: `StorageStatus`, `StorageStatusOptions`, `StorageUsage`, `StorageUsageState`, `IStorageService`, `StorageFullEvent`, `StorageFullHandler`, `StorageAccountUsage` and `StorageRejectionDetails`.
- Deprecated, still exported unchanged: `TinyCloudQuota`, `QuotaConfig`, `QuotaStatus` and `StorageQuotaInfo`. Use `storage.status()` and `on("storage.full")` instead.
