---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`DelegatedAccess` (returned by `useDelegation`, and by `TinyCloudWeb.useDelegation`) can decrypt and read secrets under the delegation it was activated from: `access.encryption` is an `IEncryptionService` whose `decryptEnvelope` signs with the access's delegated session, and `access.readSecret({ name, scope? })` reads a Secrets-app secret from the delegation's space and returns the same classified `SecretReadResult` as `TinyCloudNode.readSecret`. Both work in a session-only recipient (an embedded app with no wallet and no SIWE session of its own) and target the delegation owner's encryption network. A read needs `tinycloud.kv/get` on the secret's `vault/secrets/...` record and `tinycloud.encryption/decrypt` on that network in the delegation; neither asks for or signs new authority. The node refuses a revoked or expired delegation, and a delegation issued for one space cannot read another space's records. Decrypt authority is per network: secrets are sealed to the network's root key today, so the KV grant on the record is what limits a delegation to particular secrets. `DelegatedSecretReadInput` is exported from both packages. Nothing changes for existing callers.

Details: TC-3338
