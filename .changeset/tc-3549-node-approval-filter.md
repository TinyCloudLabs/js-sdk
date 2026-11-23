---
"@tinycloud/node-sdk": minor
---

`hasRuntimePermissions` and `getRuntimePermissionDelegations` take an optional filter naming which approvals to count. `grantRuntimePermissions` takes `reuseExisting: false` to sign a new approval even when an installed one already covers the access. Existing calls and defaults behave the same.

Details: TC-3549
