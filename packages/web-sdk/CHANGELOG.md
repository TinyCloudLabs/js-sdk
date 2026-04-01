# @tinycloudlabs/web-sdk

## 2.0.3-beta.1

### Patch Changes

- 9e05e08: Move webpack polyfill packages from dependencies to devDependencies to reduce install size for consumers

## 2.0.3-beta.0

### Patch Changes

- e7e6ee7: Fix SIWE domain to default to app.tinycloud.xyz instead of TinyCloud node URL
- Updated dependencies [e7e6ee7]
  - @tinycloud/node-sdk@2.0.3-beta.0

## 2.0.2

### Patch Changes

- 3401b3c: Fix siweConfig.nonce passthrough to SIWE message generation

  The nonce field from siweConfig was accepted in the configuration but never
  forwarded to the WASM prepareSession() call, causing server-provided nonces
  to be silently ignored. This broke single-signature auth flows where an
  external service (e.g. billing sidecar) provides a nonce for verification.

- Updated dependencies [7bb188f]
- Updated dependencies [3401b3c]
  - @tinycloud/sdk-core@2.0.2
  - @tinycloud/node-sdk@2.0.2

## 2.0.1

### Patch Changes

- @tinycloud/sdk-core@2.0.1
- @tinycloud/node-sdk@2.0.1

## 2.0.0

### Major Changes

- 6eebc29: Unify web-sdk and node-sdk: TinyCloudWeb is now a thin wrapper around TinyCloudNode.

  Breaking changes (web-sdk):
  - `@tinycloud/web-core` package deleted — import types from `@tinycloud/sdk-core` or `@tinycloud/web-sdk`
  - `WebUserAuthorization` class removed — use `tcw.session()`, `tcw.did`, `tcw.address()` instead
  - `tcw.webAuth` and `tcw.userAuthorization` accessors removed
  - `WebSignStrategy` / `WalletPopupStrategy` types removed

  New in node-sdk:
  - `signer`, `wasmBindings`, `notificationHandler`, `ensResolver`, `spaceCreationHandler` config options
  - `connectSigner()` method for injecting any ISigner
  - `@tinycloud/node-sdk/core` entry point (zero Node WASM deps, for browser bundlers)
  - `restoreSession()` now initializes Vault

  New in sdk-core:
  - `INotificationHandler`, `IENSResolver`, `IWasmBindings`, `ISessionManager` interfaces
  - `ClientSession`, `SiweConfig`, `EnsData` types (moved from web-core)

  New in web-sdk:
  - `sql`, `duckdb` services now available
  - Browser adapters: `BrowserWalletSigner`, `BrowserSessionStorage`, `BrowserNotificationHandler`, `BrowserWasmBindings`, `BrowserENSResolver`
  - ENS name resolution in delegation methods

### Patch Changes

- 25d8977: Pass siweConfig.nonce through to the SIWE message via prepareSession, enabling server-provided nonce injection for single-signature auth flows
- Updated dependencies [6eebc29]
  - @tinycloud/node-sdk@2.0.0
  - @tinycloud/sdk-core@2.0.0

## 1.7.2

### Patch Changes

- 4f0dab0: Fix `global is not defined` browser error by defining global as globalThis via webpack DefinePlugin. Add `provider` shorthand to Config as alternative to `providers: { web3: { driver } }`.

## 1.7.1

### Patch Changes

- 959b3c1: Fix browser runtime errors (exports is not defined, utils.inherits is not a function) by setting webpack target to web, disabling Node.js shims, and using source-map instead of eval-source-map

## 1.7.0

### Patch Changes

- Updated dependencies [8649de8]
  - @tinycloud/web-sdk-wasm@1.7.0
  - @tinycloud/sdk-core@1.7.0
  - @tinycloud/web-core@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies [9454b78]
- Updated dependencies [db50ae4]
- Updated dependencies [bea6063]
  - @tinycloud/sdk-core@1.6.0
  - @tinycloud/web-sdk-wasm@1.6.0
  - @tinycloud/web-core@1.6.0

## 1.5.0

### Minor Changes

- ae6b69f: Ship dual ESM + CJS bundles for broad bundler compatibility. ESM consumers (Vite, SvelteKit) use `import`, CJS consumers (CRA, webpack, Node.js require()) use `require()`.

### Patch Changes

- @tinycloud/sdk-core@1.5.0

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault (encrypted KV) support with WASM crypto bindings, vault service initialization in TinyCloudWeb, public space helpers, and NodeUserAuthorization improvements
- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption
- 94ad509: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

### Patch Changes

- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
  - @tinycloud/sdk-core@1.3.0

## 1.2.0

### Minor Changes

- bcbebbe: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

### Patch Changes

- Updated dependencies [bcbebbe]
- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-core@1.2.0

## 1.1.0

### Minor Changes

- 0499ab9: Remove legacy UserAuthorization, make WebUserAuthorization the default
  - Remove `useNewAuth` config flag — `WebUserAuthorization` is now always used
  - Delete legacy `UserAuthorization` class (1,231 lines)
  - Remove `isNewAuthEnabled` getter and all legacy mode guards
  - Auth modes simplified from legacy/new-wallet/new-session-only to wallet/session-only

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

- ba988fb: Fix space-not-found race condition during sign-in. Both auth paths could complete signIn() without the space being active on the server, causing immediate "Space not found" errors from KV operations. Legacy path no longer silently swallows ensureSpaceExists() errors. New auth path throws when space creation modal is dismissed instead of returning silently.
- Updated dependencies [855e0d9]
- Updated dependencies [ba988fb]
  - @tinycloud/sdk-core@1.1.0
  - @tinycloud/web-core@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [c97e40d]
  - @tinycloud/web-sdk-wasm@1.0.1
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
  - @tinycloudlabs/web-sdk-wasm@1.0.0

## 0.4.0

### Minor Changes

- 8c448f1: Update namespace references
- 2f7f0f4: added registry for node resolution and webpack build fix using polyfills

### Patch Changes

- 69fc83e: Fix space creation flow and host configuration consistency
  - Fixed sign-in flow to setup space session before calling extension hooks
  - Added `getTinycloudHosts()` method to `IUserAuthorization` interface
  - Updated `TinyCloudStorage` to use hosts from `UserAuthorization` for consistency
  - Fixed `tryResumeSession` to also setup space before extension hooks
  - Updated demo app to pass `tinycloudHosts` at top level config

  This ensures the space exists before `TinyCloudStorage.afterSignIn()` runs,
  preventing "Space not found" errors during session activation.

- 6cf4ef6: Update logging
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

- a2b4b66: Refactor web-sdk to use shared sdk-core interfaces.

  Changes:
  - Add sdk-core dependency
  - UserAuthorization now implements IUserAuthorization from sdk-core
  - Re-export sdk-core interfaces (TinyCloud, ISigner, ISessionStorage, etc.)
  - Web-sdk can now be used with platform-agnostic sdk-core code

  Part of TC-401: IUserAuthorization shared interface implementation.

- Updated dependencies [8c448f1]
- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
  - @tinycloudlabs/web-sdk-wasm@0.4.0
  - @tinycloudlabs/sdk-core@0.2.0
  - @tinycloudlabs/web-core@0.3.1

## 0.3.0

### Minor Changes

- 91c8c4d: Update capability formation and usage to match TinyCloud node changes

### Patch Changes

- 6db4556: Add support for saved sessions in the TinyCloud SDK
- cfc0696: Remove `eval` in production builds
- Updated dependencies [91c8c4d]
  - @tinycloudlabs/web-sdk-wasm@0.3.0
  - @tinycloudlabs/web-core@0.3.0

## 0.2.1

### Patch Changes

- 5a37904: Improved wasm bundling
- 5a37904: Update Exports to include missing export
- Updated dependencies [5a37904]
  - @tinycloudlabs/web-sdk-wasm@0.2.1
  - @tinycloudlabs/web-core@0.2.1

## 0.2.0

### Minor Changes

- 64affb0: Bring up to date with EIP-5573
- 491f83c: Support initializing SDK with messages + signature
- d96805f: Include messaging with SDK operations

### Patch Changes

- Updated dependencies [64affb0]
- Updated dependencies [491f83c]
  - @tinycloudlabs/web-sdk-wasm@0.2.0
  - @tinycloudlabs/web-core@0.2.0

## 0.1.2

### Patch Changes

- 23dcfb2: Updated release
- Updated dependencies [23dcfb2]
  - @tinycloudlabs/web-core@0.1.2
  - @tinycloudlabs/web-sdk-wasm@0.1.2

## 0.1.1

### Patch Changes

- 45bae72: Security fixes
- Updated dependencies [45bae72]
  - @tinycloudlabs/web-sdk-wasm@0.1.1
  - @tinycloudlabs/web-core@0.1.1

## 0.1.0

### Minor Changes

- 5777341: Initial Web SDK Release

### Patch Changes

- Updated dependencies [5777341]
  - @tinycloudlabs/web-core@0.1.0
  - @tinycloudlabs/web-sdk-wasm@0.1.0
