---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-services": minor
---

Resolve and rehydrate `tinycloudHosts` on restored sessions.

A restored session never resolved its TinyCloud hosts: the restore path
rehydrated the delegation/address/chainId but never set the hosts, and the
hosts a session was created with weren't persisted. The first kv/secrets/
space/encryption call on a restored session therefore threw "TinyCloud
hosts have not been resolved. Call signIn() first." (notably when
`signIn()` short-circuited to a restored session).

Fix (three parts):

- Persist the hosts: `PersistedSessionData` gains an optional
  `tinycloudHosts` field (back-compat — old persisted sessions still
  validate), and both sign-in save paths write the just-resolved hosts.
- Rehydrate on restore: `TinyCloudNode.restoreSession` accepts the
  persisted `tinycloudHosts`, adopts them for the service context and the
  auth layer (`setRestoredTinyCloudSession`), and the web SDK threads the
  field through `restoreDataFromPersisted`.
- Lazy fallback: sessions persisted before this field re-resolve their
  hosts lazily (registry → `node.tinycloud.xyz` fallback) on the first
  host-needing call, exactly like a fresh sign-in. Resolution failures
  surface rather than being masked.

A restored session now targets the same node as the original sign-in, so
apps no longer need to pass `tinycloudHosts` explicitly or call
`clearPersistedSession()` before sign-in.
