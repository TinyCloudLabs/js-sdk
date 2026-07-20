# @tinycloud/mcp

## 0.3.0-beta.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0-beta.0

## 0.2.2

### Patch Changes

- @tinycloud/operations@0.2.1

## 0.2.1

### Patch Changes

- a2adb87: Publish the stable 16-tool MCP setup, delegated workflow, KV CRUD, and SQLite
  surface in the npm README and package discovery metadata.

## 0.2.1-beta.0

### Patch Changes

- a2adb87: Publish the stable 16-tool MCP setup, delegated workflow, KV CRUD, and SQLite
  surface in the npm README and package discovery metadata.

## 0.2.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0

## 0.2.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0-beta.0

## 0.1.0

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- Updated dependencies [492a656]
- Updated dependencies [1269a58]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [abe8083]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
  - @tinycloud/operations@0.1.0

## 0.1.0-beta.2

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/operations@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- Updated dependencies [492a656]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [abe8083]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
  - @tinycloud/operations@0.1.0-beta.1
