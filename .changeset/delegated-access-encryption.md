---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`DelegatedAccess` (from `useDelegation`) can read Secrets-app secrets through the delegation: `access.encryption` and `access.readSecret({ name, scope? })`, which returns the same `SecretReadResult` as `TinyCloudNode.readSecret`. A read needs `tinycloud.kv/get` on the secret's record and `tinycloud.encryption/decrypt` in the delegation.

Details: TC-3338
