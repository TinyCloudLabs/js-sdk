---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`DelegatedAccess` (from `useDelegation`) can read Secrets-app secrets through the delegation: `access.encryption` and `access.readSecret({ name, scope? })`, which returns the same `SecretReadResult` as `TinyCloudNode.readSecret`. A read needs `tinycloud.kv/get` on the secret's record and `tinycloud.encryption/decrypt` in the delegation. The decrypt permission isn't limited to that secret: it covers the owner's default network.

The new `@tinycloud/node-sdk/runtime-grants` and `@tinycloud/node-sdk/secret-read` entry points are internal: don't import them directly, as they can change in any release.

Details: TC-3338
