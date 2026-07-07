---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": patch
---

Consolidate hand-written capability URN lists into a single source of truth
(`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
in tinycloud-node and vendored verbatim as
`@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
(`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
the node-sdk default abilities and root-delegation grants, the bootstrap
manifests, and the web-sdk permission-modal labels are all derived from it. A CI
job diffs the vendored copy against the node registry at the pinned rev so the
SDK can never silently drift from the enforcer.

BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
`SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
`read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
retained as exported constants but are request-kind artifacts, not registry
capabilities (the node routes them by request-body kind; wire alignment tracked
in TC-114). All other action shapes are unchanged.
