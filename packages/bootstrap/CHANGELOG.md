# @tinycloud/bootstrap

## 2.5.0-beta.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
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

## 2.4.1

### Patch Changes

- 3b23940: Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.

## 2.4.1-beta.0

### Patch Changes

- 3b23940: Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.

## 2.4.0

### Patch Changes

- 79dd26c: Add the canonical account bootstrap manifest package, shared bootstrap schemas/allowlist, OpenKey callback signing strategy, and first-sign-in SDK bootstrap orchestration for enshrined spaces.
