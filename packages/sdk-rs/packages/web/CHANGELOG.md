# @tinycloudlabs/web-sdk-wasm

## 1.7.2-beta.0

### Patch Changes

- b55ffbd: Add manifest and capability-chain primitives to `@tinycloud/sdk-core`, and re-export `parseRecapFromSiwe` from both WASM wrappers.
  - `@tinycloud/sdk-core` gains `Manifest`, `PermissionEntry`, `ResolvedCapabilities`, `resolveManifest`, `parseExpiry`, `expandActionShortNames`, default-tier constants, `isCapabilitySubset`, `parseRecapCapabilities`, `PermissionNotInManifestError`, and `SessionExpiredError`. These are the building blocks for the `delegateTo` / `requestPermissions` flow that will follow in `@tinycloud/node-sdk` and `@tinycloud/web-sdk`.
  - `@tinycloud/node-sdk-wasm` and `@tinycloud/web-sdk-wasm` re-export `parseRecapFromSiwe`, the new WASM export in `tinycloud-node` that decodes recap capabilities from a signed SIWE message.
  - The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the commit that introduced `parseRecapFromSiwe`.
  - New `ms` dependency on `@tinycloud/sdk-core` for duration parsing.

- 9a9fae1: Re-export `invokeAny` from the node and web WASM bindings. Unblocks `@tinycloud/node-sdk@2.1.x`, which imports `invokeAny` at module load; against the published `@tinycloud/node-sdk-wasm@1.7.1` artifact (built before the symbol existed) consumers hit `SyntaxError: Export named 'invokeAny' not found in module '@tinycloud/node-sdk-wasm'`. The Rust source and TypeScript wrappers already expose `invokeAny` on master (PR #173); this changeset exists to trigger a new WASM release so the symbol reaches npm.

## 1.7.1

## 1.7.0

### Patch Changes

- 8649de8: Update tinycloud-node dependency rev for crate rename (tinycloud-lib → tinycloud-auth).

## 1.6.0

### Patch Changes

- bea6063: Update tinycloud-node dependency rev for crate rename (tinycloud-lib → tinycloud-auth).

## 1.0.1

### Patch Changes

- c97e40d: Fix broken npm packages by removing invalid @tinycloud/sdk-rs dependency
  - web-sdk-wasm: Removed runtime dependency on sdk-rs (WASM is bundled by rollup)
  - node-sdk-wasm: Removed runtime dependency on sdk-rs, now properly bundles WASM files into dist/wasm/ during build

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

## 0.4.0

### Minor Changes

- 8c448f1: Update namespace references

### Patch Changes

- a2b4b66: Fix build order to ensure WASM artifacts are built before TypeScript packages

  Added `@tinycloudlabs/sdk-rs` as a dependency so turbo builds WASM first.

- a2b4b66: Rename web-sdk-rs to sdk-rs for clearer naming
  - Renamed `packages/web-sdk-rs` to `packages/sdk-rs`
  - Renamed WASM output directories:
    - `pkg` -> `web-sdk-wasm`
    - `pkg-nodejs` -> `node-sdk-wasm`
  - Updated all build scripts, documentation, and CI workflows

- Updated dependencies [69fc83e]
  - @tinycloudlabs/sdk-rs@0.3.1
