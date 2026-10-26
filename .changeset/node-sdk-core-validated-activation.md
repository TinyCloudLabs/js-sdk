---
"@tinycloud/node-sdk": patch
---

`@tinycloud/node-sdk/core` now exports `activateValidatedRuntimeDelegation`, `RuntimeDelegationRejectedError` and the `RuntimeDelegationRejection` type, which the root entry already exported. The web SDK uses them to verify and activate a stored panel grant after a reload.

Details: TC-2113
