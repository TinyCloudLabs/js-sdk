---
"@tinycloud/node-sdk": minor
---

Delegation paths (`delegateTo`, `planDelegation`, sub-delegations, and the delegation wrapper used for WASM issuance) apply the decrypt rule as runtime grants do. Decrypt grants (`tinycloud.encryption/decrypt`, or an action covering it such as `tinycloud.encryption/*`) on the account's own networks (the default network and any non-share network) default to one hour when no expiry is given. An explicit expiry over one hour is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`, before any signing or network call. Decrypt grants on per-share networks keep their own lifetime. Grants without decrypt are unchanged.

Details: TC-1781
