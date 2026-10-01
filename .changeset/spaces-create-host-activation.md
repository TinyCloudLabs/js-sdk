---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

Fix `spaces.create(name)` to run the host-activation ceremony instead of a bare session-key invocation.

`SpaceService.create()` previously issued a `tinycloud.space/create` invocation to `POST /invoke`, which never registered the space host-side. The node then committed an epoch/event row for an unregistered space, triggering a SQLite foreign-key error that surfaced to the client as `404 - Space not found`.

`SpaceService` now accepts an injectable `hostSpace` function (mirroring the existing `createDelegation` injection). `create()` computes the full space id and runs the platform-provided host-activation ceremony (`peer/generate` → host SIWE → `POST /delegate` → session activation) instead of the invocation, then returns a locally-built `SpaceInfo`. When no `hostSpace` function is injected, `create()` returns a `NOT_INITIALIZED` error rather than falling back to the FK-triggering invocation. `TinyCloudNode` supplies `hostSpace` by reusing its existing `hostPublicSpace` ceremony plus `activateSessionWithHost`.

As a result, `spaces.create('default')` returns an id equal to the session's primary space id, and immediate KV/SQL operations on that space succeed.
