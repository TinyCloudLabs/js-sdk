---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

`grantRuntimePermissions` now limits runtime grants that include `tinycloud.encryption/decrypt` to one hour. Automatic grants default to one hour instead of 30 days. An explicit `expiry` longer than one hour for a decrypt grant is refused with `DecryptExpiryTooLongError` (`code` `DECRYPT_EXPIRY_TOO_LONG`). Grants without decrypt keep their previous default and accept explicit expiries as before.

Details: TC-1781
