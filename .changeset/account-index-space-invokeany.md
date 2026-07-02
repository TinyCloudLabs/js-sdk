---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Wire `invokeAny` into the space-scoped service contexts built by
`TinyCloudNode.sqlForSpace`, `kvForSpace`, and `createSpaceScopedKVService`.
Previously these clones omitted `invokeAny`, so any space-scoped multi-ability
operation — notably the `CREATE TABLE` + `INSERT` migrations batch that
`account.index.ensure()` runs against the space-scoped `account` DB — threw
`SQL operation ... does not support multi-resource invocations` client-side
before any network call. Space-scoped SQL/KV multi-ability invocations now route
through `invokeAnyWithRuntimePermissions` (signed by the session key, so no
additional wallet signatures), matching the primary-space contexts.
