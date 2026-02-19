# @tinycloudlabs/node-sdk

## 1.2.0

### Minor Changes

- 2014a20: Add sessionStorage to TinyCloudNodeConfig types and switch build to tsup for proper ESM/CJS output
- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support

  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

### Patch Changes

- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-core@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [855e0d9]
- Updated dependencies [ba988fb]
  - @tinycloud/sdk-core@1.1.0
  - @tinycloud/web-core@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [c97e40d]
  - @tinycloud/node-sdk-wasm@1.0.1
  - @tinycloud/web-core@1.0.1
  - @tinycloud/sdk-core@1.0.1

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

### Patch Changes

- b863afb: Fix sharing link delegation bugs

  - Fix 401 Unauthorized error: Clamp sharing link expiry to session expiry to ensure child delegation expiry never exceeds parent
  - Fix "Invalid symbol 32" base64 decode error: Remove incorrect "Bearer " prefix from authHeader in sharing link data

- Updated dependencies [b863afb]
- Updated dependencies [866981c]
  - @tinycloudlabs/sdk-core@1.0.0
  - @tinycloudlabs/web-core@1.0.0
  - @tinycloudlabs/node-sdk-wasm@1.0.0

## 0.2.0

### Minor Changes

- a2b4b66: Breaking API changes for node-sdk delegation system

  ### node-sdk

  **BREAKING: `allowSubDelegation` → `disableSubDelegation`**

  - Sub-delegation is now allowed by default (aligns with ocap/UCAN expectations)
  - Use `disableSubDelegation: true` to prevent recipients from creating sub-delegations
  - Before: `createDelegation({ allowSubDelegation: true })` to enable
  - After: `createDelegation({})` enables by default, use `disableSubDelegation: true` to disable

  **BREAKING: `autoCreateNamespace` default changed to `false`**

  - Namespaces are no longer auto-created during sign-in
  - Use `autoCreateNamespace: true` explicitly for namespace owners
  - Delegates using shared namespaces should not set this flag

  ### web-sdk

  - Fixed `KVServiceAdapter` to include `jwk` property required by `ServiceSession`

### Patch Changes

- a2b4b66: Create node-sdk package with Node.js-specific TinyCloud SDK implementations.

  This package provides:

  - `PrivateKeySigner`: ISigner implementation using private keys via WASM
  - `NodeUserAuthorization`: IUserAuthorization with configurable sign strategies
    - auto-sign: Automatically approve all sign requests
    - auto-reject: Reject all sign requests
    - callback: Delegate to custom callback function
    - event-emitter: Emit sign requests as events
  - `MemorySessionStorage`: In-memory ISessionStorage
  - `FileSessionStorage`: File-based ISessionStorage for session persistence

  Part of TC-401: IUserAuthorization shared interface implementation.

- a2b4b66: Fix delegation chain support for user-to-user delegations

  - Added `pkhDid` getter for PKH DID format (`did:pkh:eip155:{chainId}:{address}`)
  - Fixed `createDelegation` to use `delegateUri` for targeting recipient's PKH DID
  - Fixed `createSubDelegation` to use `delegateUri` instead of generating random JWK
  - Fixed sub-delegation expiry to cap at parent's expiry instead of throwing error
  - Updated demo to use `pkhDid` for all delegations

  Full delegation chain now works: Alice → Bob → Charlie

- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
  - @tinycloudlabs/sdk-core@0.2.0
  - @tinycloudlabs/node-sdk-wasm@0.1.1
  - @tinycloudlabs/web-core@0.3.1
