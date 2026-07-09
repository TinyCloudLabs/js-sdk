---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Fix account bootstrap failing on fresh keys because `sqlForSpace()` dropped `invokeAny` (issue #300).

`TinyCloudNode.sqlForSpace()` (and its `kvForSpace()` counterpart) cloned the
active service context with only `{invoke, fetch, hosts, telemetry}`, silently
omitting `invokeAny`. Account bootstrap routes through this path: the
`account-index-schema` step calls `account.index.ensure()`, whose migration
batch dedupes to multiple SQL actions (`tinycloud.sql/schema` +
`tinycloud.sql/write`). A multi-action batch requires `context.invokeAny`, so
with it undefined `SQLService.invokeSQLAny` threw
"SQL operation requires multiple permissions ... does not support
multi-resource invocations", and the first `signIn()` on a fresh key failed to
provision the account index (the `secret-records-schema` step would have hit
the identical failure). The "recovery" on a second `signIn()` was accidental
and incomplete — the existence check could pass and skip the schema step,
leaving accounts without the account index.

Thread `invokeAny` from the primary service context (`this._serviceContext.invokeAny`)
into the space-scoped context that `sqlForSpace()` and `kvForSpace()` build, so
multi-action bootstrap migrations mint their authorization header correctly.
