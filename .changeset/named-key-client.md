---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
---

Add a named encryption key client: key create, block and unblock, key descriptor reads, `ensureKey`, and key-scoped encrypt and decrypt. It is exposed under the `@tinycloud/sdk-services/encryption/named-keys` and `@tinycloud/node-sdk/encryption-keys` subpaths and is only used with nodes that advertise support.

Details: TC-1777
