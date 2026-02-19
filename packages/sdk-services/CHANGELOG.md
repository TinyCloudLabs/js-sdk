# @tinycloudlabs/sdk-services

## 1.2.0

### Minor Changes

- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support

  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

## 1.0.0

### Major Changes

- 866981c: # v1.0.0 Release

  ## Protocol Version System

  - Added `checkNodeVersion()` to all sign-in flows for SDK-node compatibility verification
  - Added `ProtocolMismatchError` and `VersionCheckError` error types
  - SDK now requires TinyCloud Node v1.0.0+ with `/version` endpoint

  ## API Surface Cleanup

  - Replaced blanket `export *` with explicit curated exports
  - Renamed 40+ `TCW`-prefixed types (e.g. `TCWClientSession` -> `ClientSession`, `TCWExtension` -> `Extension`)
  - Trimmed internal utilities from public API surface

  ## Breaking Changes

  - All `TCW`-prefixed types have been renamed (drop the `TCW` prefix)
  - Blanket re-exports from `@tinycloudlabs/web-core` removed; use explicit named imports
  - Some internal sdk-core utilities removed from public API
  - `SharingServiceV2` alias removed; use `SharingService` directly
