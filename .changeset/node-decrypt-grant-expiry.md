---
"@tinycloud/node-sdk": minor
---

`grantRuntimePermissions` limits runtime grants that include decrypt (`tinycloud.encryption/decrypt`, or an action covering it such as `tinycloud.encryption/*`) to one hour. Without an `expiry`, such grants default to one hour instead of 30 days. An explicit `expiry` over one hour is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`. Grants without decrypt are unchanged.

Details: TC-1781
