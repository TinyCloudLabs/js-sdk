---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
---

`grantRuntimePermissions` now limits runtime grants that include decrypt to one hour. Decrypt is `tinycloud.encryption/decrypt`, or any action that covers it such as `tinycloud.encryption/*`. Automatic grants default to one hour instead of 30 days. An explicit `expiry` longer than one hour for a decrypt grant is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`. Grants without decrypt keep their previous default and accept explicit expiries as before.

Details: TC-1781
