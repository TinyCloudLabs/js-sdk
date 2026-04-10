# @tinycloudlabs/sdk-services

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

## 2.1.0-beta.0

### Minor Changes

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

## 2.0.3

## 2.0.2

### Patch Changes

- 7bb188f: Fix ESM compatibility by migrating sdk-core and sdk-services from tsc to tsup. Resolves extensionless import errors in Node's strict ESM resolver (e.g. Next.js instrumentation hooks).

## 2.0.1

### Patch Changes

- 75690db: Cache vault signatures in IndexedDB (encrypted with non-extractable AES-GCM CryptoKey) to eliminate repeated wallet popups on unlock. Skip identity signing entirely when public key already exists in public space. Add version-keyed signing constants (VaultVersionConfig) for forward-compatible key derivation. Gracefully no-ops in Node.js.

## 1.7.0

### Minor Changes

- 8649de8: Add `AUTH_UNAUTHORIZED` error code and 401 handling across all services. When the server returns 401 with "Unauthorized Action: {resource} / {ability}", the SDK now parses the response and returns a structured `AUTH_UNAUTHORIZED` error with `requiredAction` and `resource` in meta. Affects KV, SQL, and DuckDB services.
- 8649de8: Add storage quota error handling and TinyCloudQuota helper. New error codes `STORAGE_QUOTA_EXCEEDED` (402) and `STORAGE_LIMIT_REACHED` (413) with quota info parsing in KVService. New `TinyCloudQuota` class for querying quota status from the quota URL discovered via `/info`.

### Patch Changes

- def099d: Skip redundant public key writes on vault unlock and auto-include public-space KV delegation when creating delegations with KV actions. Remove unused VaultAction constants.

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

## 1.5.0

### Minor Changes

- 9d6b79f: Add vault.reencrypt() method as the preferred name for vault.grant(). The grant() method is now a deprecated alias that delegates to reencrypt(). Internal revoke() also uses reencrypt().

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption

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
