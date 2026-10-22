---
"@tinycloud/node-sdk": minor
---

`grantRuntimePermissions` applies a one-hour decrypt limit to decrypt grants on the account's own networks: the default network and any non-share network. Decrypt grants are those with `tinycloud.encryption/decrypt`, or an action covering it such as `tinycloud.encryption/*`. Without an `expiry`, such grants default to one hour instead of 30 days. An explicit `expiry` over one hour is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`. Decrypt grants on per-share networks keep their own lifetime. Grants without decrypt are unchanged.

Details: TC-1781
