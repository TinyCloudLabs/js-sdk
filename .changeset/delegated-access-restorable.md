---
"@tinycloud/node-sdk": patch
---

Expose `DelegatedAccess.restorable` — a read-only projection of the activated session handles (`delegationHeader`, `delegationCid`, `spaceId`, `jwk`, `verificationMethod`, `address`, `chainId`) in the exact shape `TinyCloudNode.restoreSession(...)` consumes. Enables persisting a `useDelegation` activation across processes or restarts (e.g. agent runtimes that want vanilla `@tinycloud/cli` to operate against a delegated space). Note: in wallet mode the header/cid are minted against the activator's server-side session and expire with it (~1h), so callers must periodically re-run `useDelegation` + `restoreSession`.
