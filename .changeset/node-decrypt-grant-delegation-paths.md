---
"@tinycloud/node-sdk": minor
---

Delegation paths (`delegateTo`, `planDelegation`, owner and sharing root delegations, sub-delegations, and the delegation wrapper used for WASM issuance) apply the same decrypt rule as runtime grants. Grants that include decrypt (`tinycloud.encryption/decrypt`, or an action covering it such as `tinycloud.encryption/*`) default to one hour when no expiry is given, and an explicit expiry over one hour is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`, before any signing or network call. Sharing roots report that error unchanged. Grants without decrypt are unchanged.

Details: TC-1781
