# @tinycloudlabs/sdk-core

## 2.1.0-beta.4

### Patch Changes

- c586568: fix(node-sdk): activate WASM-path delegations with the host so downstream consumers can reference the parent CID

  `createDelegationViaWasmPath` (the session-key UCAN fast path used by
  `tcw.delegateTo` when the requested capabilities are derivable from the
  current session) was building the UCAN client-side and returning it
  directly without posting it to the host. This meant the host's delegation
  store never saw the UCAN.

  When a downstream consumer (e.g. a backend calling `node.useDelegation`)
  tried to reference the UCAN's CID as the parent of its own invoker SIWE,
  the host's chain-validation step failed with "Cannot find parent
  delegation" — the host looks up parents by CID in its local database,
  and the client-side-only UCAN was never stored.

  Fix: after computing the UCAN in `createDelegationViaWasmPath`, call
  `activateSessionWithHost` to POST the delegation header to `/delegate`
  before returning the `PortableDelegation`. This mirrors the legacy
  `createDelegationWalletPath` which has done the same for wallet-signed
  SIWE delegations since day one.

- Updated dependencies [c586568]
  - @tinycloud/sdk-services@2.1.0-beta.4

## 2.1.0-beta.3

### Patch Changes

- b88728a: fix(sdk-core): normalize space URI in recap parse for derivability check

  The Rust WASM `parseRecapFromSiwe` returns `space` as the full recap target
  URI (`tinycloud:pkh:eip155:{chainId}:{address}:{name}`), while manifest
  permissions and backend-advertised permissions use the short `{name}` form
  (e.g. `"default"`). `isCapabilitySubset` was doing strict string comparison
  on `space`, so mixing the two forms always failed — `delegateTo` would throw
  `PermissionNotInManifestError` even when the session recap covered every
  requested capability.

  This broke end-to-end manifest-driven sign-in in the listen app, where the
  session SIWE was signed correctly with the union of all manifest abilities
  but `delegateTo(backendDID, info.permissions)` still failed on the subset
  check because `"tinycloud:pkh:eip155:1:0xd559...:default"` and `"default"`
  didn't match as strings.

  Fix: add a `normalizeSpace` helper that extracts the trailing name segment
  from a `tinycloud:` URI. Apply it in `parseRecapCapabilities` (so the output
  is always in short-name form) and defensively in `isCapabilitySubset` on
  both sides (so callers passing either form work transparently).

- Updated dependencies [b88728a]
  - @tinycloud/sdk-services@2.1.0-beta.3

## 2.1.0-beta.2

### Minor Changes

- 9dad135: Wire manifest-driven `signIn` and multi-resource `delegateTo` end-to-end (closes the two gaps in `2.1.0-beta.1`).

  `signIn` now reads `config.manifest` and resolves it (via `resolveManifest` + the new `manifestAbilitiesUnion`) into the WASM `abilities` map used by `prepareSession`. The resulting SIWE recap covers the union of the app's own permissions AND every manifest-declared delegation's permissions, so the session key acquires coverage for both runtime use and downstream sub-delegations in one wallet prompt. Apps that don't pass a manifest fall back to `defaultActions` (legacy behaviour, no change).

  `delegateTo(did, permissions)` no longer rejects multi-entry input. The SDK now folds every `(service, path, actions)` entry into a single multi-resource abilities map and calls the WASM `createDelegation` once — producing ONE signed UCAN whose `attenuation` carries every grant. The returned `PortableDelegation` has the new optional `resources?: DelegatedResource[]` field listing the full breakdown; the legacy flat `path` + `actions` fields mirror the first (sorted) resource for back-compat.

  Listen-style apps that needed to delegate KV + SQL on the same prefix to a backend can now do so in a single `tcw.delegateTo(backendDID, [...])` call with no wallet prompt.

  **Breaking changes** — pre-2.1.0-beta.2 callers will need to update:
  - `@tinycloud/sdk-core`: `CreateDelegationWasmParams` swaps `path: string; actions: string[]` for `abilities: Record<string, Record<string, string[]>>`. `CreateDelegationWasmResult` swaps the flat `path` + `actions` for `resources: DelegatedResource[]`. New exports: `DelegatedResource`, `AbilitiesMap`, `manifestAbilitiesUnion`, `resourceCapabilitiesToAbilitiesMap`.
  - `@tinycloud/node-sdk`: `TinyCloudNodeConfig` gains an optional `manifest?: Manifest` field. `TinyCloudNode` gains `setManifest(manifest)` and `manifest` getter passthroughs to the underlying auth handler. `delegateTo` no longer throws on multi-entry input — apps that relied on that behaviour for validation must add their own length check. `PortableDelegation` gains an optional `resources?: DelegatedResource[]` field.
  - `@tinycloud/web-sdk`: `TinyCloudWeb.setManifest()` now forwards the new manifest into the underlying `TinyCloudNode` so the next `signIn()` picks it up. `BrowserWasmBindings.createDelegation` signature aligned with the new WASM ABI.
  - `@tinycloud/node-sdk-wasm` / `@tinycloud/web-sdk-wasm`: the `createDelegation` WASM export takes `abilities: object` (multi-resource map) instead of `path: string, actions: string[]`. The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the merge commit of the `feat/create-delegation-multi-resource` PR in `tinycloud-node`.

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/sdk-services@2.1.0-beta.1

## 2.1.0-beta.0

### Minor Changes

- b55ffbd: Add manifest and capability-chain primitives to `@tinycloud/sdk-core`, and re-export `parseRecapFromSiwe` from both WASM wrappers.
  - `@tinycloud/sdk-core` gains `Manifest`, `PermissionEntry`, `ResolvedCapabilities`, `resolveManifest`, `parseExpiry`, `expandActionShortNames`, default-tier constants, `isCapabilitySubset`, `parseRecapCapabilities`, `PermissionNotInManifestError`, and `SessionExpiredError`. These are the building blocks for the `delegateTo` / `requestPermissions` flow that will follow in `@tinycloud/node-sdk` and `@tinycloud/web-sdk`.
  - `@tinycloud/node-sdk-wasm` and `@tinycloud/web-sdk-wasm` re-export `parseRecapFromSiwe`, the new WASM export in `tinycloud-node` that decodes recap capabilities from a signed SIWE message.
  - The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the commit that introduced `parseRecapFromSiwe`.
  - New `ms` dependency on `@tinycloud/sdk-core` for duration parsing.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- Updated dependencies [61c031d]
  - @tinycloud/sdk-services@2.1.0-beta.0

## 2.0.4-beta.0

### Patch Changes

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.

## 2.0.3

### Patch Changes

- c2f2d54: Upgrade siwe from v2 to v3 (rewritten ABNF parser, removed deprecated validate method)
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.
  - @tinycloud/sdk-services@2.0.3

## 2.0.3-beta.3

### Patch Changes

- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

## 2.0.3-beta.2

### Patch Changes

- c2f2d54: Upgrade siwe from v2 to v3 (rewritten ABNF parser, removed deprecated validate method)

## 2.0.2

### Patch Changes

- 7bb188f: Fix ESM compatibility by migrating sdk-core and sdk-services from tsc to tsup. Resolves extensionless import errors in Node's strict ESM resolver (e.g. Next.js instrumentation hooks).
- Updated dependencies [7bb188f]
  - @tinycloud/sdk-services@2.0.2

## 2.0.1

### Patch Changes

- Updated dependencies [75690db]
  - @tinycloud/sdk-services@2.0.1

## 2.0.0

### Minor Changes

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

## 1.7.0

### Patch Changes

- Updated dependencies [8649de8]
- Updated dependencies [8649de8]
- Updated dependencies [def099d]
  - @tinycloud/sdk-services@1.7.0
  - @tinycloud/web-core@1.7.0

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

### Patch Changes

- 9454b78: Add unit tests for `activateSessionWithHost` covering successful activation, old-server fallback, error responses, body read failures, and request construction.
- Updated dependencies [db50ae4]
  - @tinycloud/sdk-services@1.6.0
  - @tinycloud/web-core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [9d6b79f]
  - @tinycloud/sdk-services@1.5.0

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault (encrypted KV) support with WASM crypto bindings, vault service initialization in TinyCloudWeb, public space helpers, and NodeUserAuthorization improvements
- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption
- 94ad509: Add multi-space session support with enablePublicSpace config (default: true). Single signIn covers both primary and public space. Fix space-scoped KV factory to properly scope to target space.
- 94ad509: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

- 94ad509: Register DataVaultService in TinyCloudNode with WASM crypto bindings and rewrite vault demo to use SDK

### Patch Changes

- Updated dependencies [94ad509]
  - @tinycloud/sdk-services@1.3.0

## 1.2.0

### Minor Changes

- bcbebbe: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

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
