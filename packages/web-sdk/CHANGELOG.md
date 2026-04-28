# @tinycloudlabs/web-sdk

## 2.2.0-beta.2

### Patch Changes

- Updated dependencies [04a0d5c]
  - @tinycloud/node-sdk@2.2.0-beta.2

## 2.2.0-beta.1

### Patch Changes

- Updated dependencies [de4d662]
  - @tinycloud/sdk-core@2.2.0-beta.1
  - @tinycloud/node-sdk@2.2.0-beta.1

## 2.2.0-beta.0

### Minor Changes

- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/sdk-core@2.2.0-beta.0
  - @tinycloud/node-sdk@2.2.0-beta.0
  - @tinycloud/web-sdk-wasm@1.7.3-beta.0

## 2.1.0

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

- 9dad135: Wire manifest-driven `signIn` and multi-resource `delegateTo` end-to-end (closes the two gaps in `2.1.0-beta.1`).

  `signIn` now reads `config.manifest` and resolves it (via `resolveManifest` + the new `manifestAbilitiesUnion`) into the WASM `abilities` map used by `prepareSession`. The resulting SIWE recap covers the union of the app's own permissions AND every manifest-declared delegation's permissions, so the session key acquires coverage for both runtime use and downstream sub-delegations in one wallet prompt. Apps that don't pass a manifest fall back to `defaultActions` (legacy behaviour, no change).

  `delegateTo(did, permissions)` no longer rejects multi-entry input. The SDK now folds every `(service, path, actions)` entry into a single multi-resource abilities map and calls the WASM `createDelegation` once — producing ONE signed UCAN whose `attenuation` carries every grant. The returned `PortableDelegation` has the new optional `resources?: DelegatedResource[]` field listing the full breakdown; the legacy flat `path` + `actions` fields mirror the first (sorted) resource for back-compat.

  Listen-style apps that needed to delegate KV + SQL on the same prefix to a backend can now do so in a single `tcw.delegateTo(backendDID, [...])` call with no wallet prompt.

  **Breaking changes** — pre-2.1.0-beta.2 callers will need to update:
  - `@tinycloud/sdk-core`: `CreateDelegationWasmParams` swaps `path: string; actions: string[]` for `abilities: Record<string, Record<string, string[]>>`. `CreateDelegationWasmResult` swaps the flat `path` + `actions` for `resources: DelegatedResource[]`. New exports: `DelegatedResource`, `AbilitiesMap`, `manifestAbilitiesUnion`, `resourceCapabilitiesToAbilitiesMap`.
  - `@tinycloud/node-sdk`: `TinyCloudNodeConfig` gains an optional `manifest?: Manifest` field. `TinyCloudNode` gains `setManifest(manifest)` and `manifest` getter passthroughs to the underlying auth handler. `delegateTo` no longer throws on multi-entry input — apps that relied on that behaviour for validation must add their own length check. `PortableDelegation` gains an optional `resources?: DelegatedResource[]` field.
  - `@tinycloud/web-sdk`: `TinyCloudWeb.setManifest()` now forwards the new manifest into the underlying `TinyCloudNode` so the next `signIn()` picks it up. `BrowserWasmBindings.createDelegation` signature aligned with the new WASM ABI.
  - `@tinycloud/node-sdk-wasm` / `@tinycloud/web-sdk-wasm`: the `createDelegation` WASM export takes `abilities: object` (multi-resource map) instead of `path: string, actions: string[]`. The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the merge commit of the `feat/create-delegation-multi-resource` PR in `tinycloud-node`.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
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

- 4fac901: Publish the UCAN delegation header fix from PR #192.

  `createDelegationViaWasmPath` now activates session-key UCAN delegations with
  the raw serialized JWT in the `Authorization` header instead of prefixing it
  with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
  the prefixed value causes host activation to fail with 401 during
  manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [303a8eb]
- Updated dependencies [8abfb4e]
- Updated dependencies [b55ffbd]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [9dad135]
- Updated dependencies [4fac901]
- Updated dependencies [9a9fae1]
- Updated dependencies [fb1d3fd]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-core@2.1.0
  - @tinycloud/node-sdk@2.1.0
  - @tinycloud/web-sdk-wasm@1.7.2

## 2.1.0-beta.6

### Patch Changes

- 4fac901: Publish the UCAN delegation header fix from PR #192.

  `createDelegationViaWasmPath` now activates session-key UCAN delegations with
  the raw serialized JWT in the `Authorization` header instead of prefixing it
  with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
  the prefixed value causes host activation to fail with 401 during
  manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.

- Updated dependencies [4fac901]
  - @tinycloud/node-sdk@2.1.0-beta.6

## 2.1.0-beta.5

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
- Updated dependencies [303a8eb]
  - @tinycloud/sdk-core@2.1.0-beta.5
  - @tinycloud/node-sdk@2.1.0-beta.5

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
  - @tinycloud/sdk-core@2.1.0-beta.4
  - @tinycloud/node-sdk@2.1.0-beta.4

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
  - @tinycloud/sdk-core@2.1.0-beta.3
  - @tinycloud/node-sdk@2.1.0-beta.3

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

### Patch Changes

- Updated dependencies [9dad135]
  - @tinycloud/sdk-core@2.1.0-beta.2
  - @tinycloud/node-sdk@2.1.0-beta.2
  - @tinycloud/web-sdk-wasm@1.7.2-beta.2

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/sdk-core@2.1.0-beta.1
  - @tinycloud/node-sdk@2.1.0-beta.1
  - @tinycloud/web-sdk-wasm@1.7.2-beta.1

## 2.1.0-beta.0

### Minor Changes

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- Updated dependencies [b55ffbd]
- Updated dependencies [9a9fae1]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-core@2.1.0-beta.0
  - @tinycloud/web-sdk-wasm@1.7.2-beta.0
  - @tinycloud/node-sdk@2.1.0-beta.0

## 2.0.4-beta.0

### Patch Changes

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [fb1d3fd]
  - @tinycloud/sdk-core@2.0.4-beta.0
  - @tinycloud/node-sdk@2.0.4-beta.0

## 2.0.3

### Patch Changes

- c2f2d54: Upgrade siwe from v2 to v3 (rewritten ABNF parser, removed deprecated validate method)
- e7e6ee7: Fix SIWE domain to default to app.tinycloud.xyz instead of TinyCloud node URL
- 9e05e08: Move webpack polyfill packages from dependencies to devDependencies to reduce install size for consumers
- 1379b11: Preserve `siweConfig` when upgrading from session-only mode via `connectWallet()` or `connectSigner()`
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

- Updated dependencies [c2f2d54]
- Updated dependencies [e7e6ee7]
- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/sdk-core@2.0.3
  - @tinycloud/node-sdk@2.0.3
  - @tinycloud/web-sdk-wasm@1.7.1

## 2.0.3-beta.3

### Patch Changes

- 1379b11: Preserve `siweConfig` when upgrading from session-only mode via `connectWallet()` or `connectSigner()`
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3-beta.3
  - @tinycloud/sdk-core@2.0.3-beta.3

## 2.0.3-beta.2

### Patch Changes

- c2f2d54: Upgrade siwe from v2 to v3 (rewritten ABNF parser, removed deprecated validate method)
- Updated dependencies [c2f2d54]
  - @tinycloud/sdk-core@2.0.3-beta.2
  - @tinycloud/node-sdk@2.0.3-beta.2

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
