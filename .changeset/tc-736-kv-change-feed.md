---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/bootstrap": minor
---

TC-736: KV change feed client for `tinycloud.kv/sync` (tinycloud-node TC-732).

- `kv.changes({ prefix, cursor?, limit?, retentionGrant?, signal?, timeout? })` reads one page of the ordered, delete-aware feed for a prefix and returns `{ changes, more, cursor, source, authority }`. Each change is a key's latest state (`{ key, deleted: false, etag, metadata }` or `{ key, deleted: true }`); read content with `get`/`batchGet` and check it against the ETag. A page never splits one invocation, so it can hold more than `limit` changes, and it can be empty with `more: true`. The cursor is opaque. The node must advertise `kv-sync-v1` in `/info`.
- `prefix` and the returned keys are full paths in the space; the service's configured prefix is not applied. On a prefixed `KVService` such as `DelegatedAccess.kv`, strip that prefix before calling `get(change.key)`, or use `kv.withPrefix(path).changes()`, which follows everything under `path/` and returns keys relative to it. An empty prefix, on either form, is refused with `INVALID_INPUT`.
- Errors: HTTP 410 is `KV_SYNC_RESET_REQUIRED` with `meta.reason` (`cursor-invalid` or `position-unknown`): discard sync state and restart without a cursor. A 401 naming `delegation-revoked` or `delegation-ancestor-revoked` is `AUTH_DELEGATION_REVOKED` or `AUTH_DELEGATION_ANCESTOR_REVOKED`. A refused retention grant (403) is `KV_RETENTION_GRANT_REFUSED` with `meta.reason`. A 404 for an unhosted space is `KV_NOT_FOUND`. The timeout and abort signal stay in force while an error body is read.
- `KVAction.SYNC`, `KVAction.RETAIN`, `KV.SYNC` and `KV.RETAIN` name the new abilities. The vendored capability registry is re-vendored from tinycloud-node `d7f511f`, which registers both.
- `tinycloud.kv/sync` and `tinycloud.kv/retain` must be granted by name. `actionContains` (exported with the new `isExplicitOnlyAction`), `SharingService.preflightGenerate()`/`generate()` and node-sdk's runtime-grant check no longer let `*` or `tinycloud.kv/*` cover them, matching the node. No default session or manifest includes them. Behaviour changes: a session holding only `tinycloud.kv/*` can no longer delegate either ability onward without a prompt, and a share asking for either under a `*` registry entry now goes to `onRootDelegationNeeded`. `SharingService` now uses `actionContains` for every action, so a `tinycloud.kv/*` registry entry covers the other KV actions there too, as it already did elsewhere.
- Type-level break for outside implementers: `IKVService` (and the `IKVServiceLike` that `PrefixedKVService` wraps) gains a required `changes(options)` member, and `IPrefixedKVService` gains `changes(options?)`. A custom class or object that implements these interfaces must add the method to compile.
- `secrets.listAll()` now fails with `INVALID_INPUT` when the node repeats a continuation cursor, instead of looping on a node that ignores list cursors.
