---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk-wasm": patch
"@tinycloud/web-sdk-wasm": patch
---

Add manifest and capability-chain primitives to `@tinycloud/sdk-core`, and re-export `parseRecapFromSiwe` from both WASM wrappers.

- `@tinycloud/sdk-core` gains `Manifest`, `PermissionEntry`, `ResolvedCapabilities`, `resolveManifest`, `parseExpiry`, `expandActionShortNames`, default-tier constants, `isCapabilitySubset`, `parseRecapCapabilities`, `PermissionNotInManifestError`, and `SessionExpiredError`. These are the building blocks for the `delegateTo` / `requestPermissions` flow that will follow in `@tinycloud/node-sdk` and `@tinycloud/web-sdk`.
- `@tinycloud/node-sdk-wasm` and `@tinycloud/web-sdk-wasm` re-export `parseRecapFromSiwe`, the new WASM export in `tinycloud-node` that decodes recap capabilities from a signed SIWE message.
- The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the commit that introduced `parseRecapFromSiwe`.
- New `ms` dependency on `@tinycloud/sdk-core` for duration parsing.
