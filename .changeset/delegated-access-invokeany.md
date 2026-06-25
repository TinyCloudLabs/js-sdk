---
"@tinycloud/node-sdk": patch
---

Thread `invokeAny` into `DelegatedAccess` so delegated sessions can form multi-action SQL invocations. `DelegatedAccess` previously built its `ServiceContext` with only the single-action `invoke`, so any SQL operation needing more than one action in a single `/invoke` — e.g. the migration runner's `ensureMigrationsTable`, which bundles a `CREATE TABLE` schema action with the tracking-row `write` — threw `SQL operation requires multiple permissions ... but this SDK runtime does not support multi-resource invocations`. `DelegatedAccess` now accepts an optional `invokeAny`, and both `TinyCloudNode` construction sites pass `wasmBindings.invokeAny`, mirroring how the top-level node session already wires it.
