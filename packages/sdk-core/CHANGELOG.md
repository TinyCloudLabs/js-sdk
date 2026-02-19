# @tinycloudlabs/sdk-core

## 1.2.0

### Minor Changes

- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support

  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

### Patch Changes

- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-services@1.2.0

## 1.1.0

### Minor Changes

- 855e0d9: Remove legacy code for v1 cleanup

  - Remove deprecated `onSessionExtensionNeeded` callback from SharingService (use `onRootDelegationNeeded` instead)
  - Remove deprecated `extendSessionForSharing()` method from TinyCloudWeb
  - Remove legacy `delegationCid` share link format support (only `cid` is supported)
  - Remove legacy fallback in `getSessionExpiry()`
  - Remove unused `express` and `express-session` dependencies from web-core

- ba988fb: feat: Add root delegation support for long-lived share links

  When creating share links with expiry longer than the current session, the SDK now creates a direct delegation from the wallet (PKH) to the share key, bypassing the session delegation chain. This allows share links to have any expiry duration regardless of session length.

  **New callback**: `onRootDelegationNeeded` in SharingServiceConfig

  - Called when share expiry exceeds session expiry
  - Receives the share key DID to delegate to
  - Returns a direct wallet-to-share-key delegation

  **Deprecated**: `onSessionExtensionNeeded` - does not solve the expiry problem as sub-delegations are still constrained by parent expiry.

  **Breaking change**: None - new callback is optional, falls back to existing behavior.

### Patch Changes

- Updated dependencies [855e0d9]
  - @tinycloud/web-core@1.1.0

## 1.0.1

### Patch Changes

- @tinycloud/web-core@1.0.1

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

- Updated dependencies [866981c]
  - @tinycloudlabs/web-core@1.0.0
  - @tinycloudlabs/sdk-services@1.0.0

## 0.2.0

### Minor Changes

- a2b4b66: Create sdk-core package with shared interfaces and TinyCloud class

  - ISigner: Platform-agnostic signer interface
  - ISessionStorage: Session persistence abstraction
  - IUserAuthorization: Main authorization interface
  - ITinyCloudStorage: Storage operations interface
  - TinyCloud: Unified SDK class that accepts IUserAuthorization

  This package enables code sharing between web-sdk and node-sdk while
  allowing platform-specific implementations for signing and session storage.

### Patch Changes

- @tinycloudlabs/web-core@0.3.1
