---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/share-sdk": minor
---

Share one item made of several resources with a single link, and open it in an app.

- `sharing.generate({ resources: [{ path, actions? }, …] })` grants up to 16 distinct paths in one share, with one owner approval when a new root is needed. `path`/`actions` keep working for a single resource. `onRootDelegationNeeded` now also receives `resources`, and a root it returns must be the owner's signature over every resource.
- `sharing.delegateReceivedShare` signs one child over every shared resource (or narrows to one with `path`), and reports a node refusal for a revoked chain as `REVOKED` and an expired one as `AUTH_EXPIRED`.
- `inspectShareToken(token)` checks a share token offline against the owner's wallet signature and returns the owner, the exact resources and when access ends. Use it for anything shown before a share is claimed.
- `useDelegation` on a delegation of several resources gives a `kv` that takes full keys; `DelegatedAccess.resources` and `ShareAccess.resources` list every resource.
- `@tinycloud/share-sdk/native-link` adds `publishNativeShareLink` and `openNativeShareLink`: a short link to a sealed record carrying the share and up to 8 KiB of app display data, opened without reading the owner's node. The display data is not signed by the owner.

Details: TC-3194
