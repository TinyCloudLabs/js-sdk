---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Bump the tinycloud-node WASM-build pin to the v1.4.5 release tag and re-vendor
the capability registry artifact (TC-119 / TC-121).

`packages/sdk-rs/Cargo.toml` now pins `tinycloud-sdk-rs`/`tinycloud-sdk-wasm` to
`tag = "v1.4.5"` (was `v1.4.2`). v1.4.5 is the first release that both contains
the TC-112 capability registry AND wires it into the live `/invoke`//`/delegate`
chain-containment paths (TC-119: alias/implication-aware delegation and
invocation models). Unlike the v1.4.2 pin — where the registry was decoupled and
the compiled WASM was unaffected — the WASM compiled from this pin genuinely
changes (the `tinycloud-auth` crate it links in gained the W1 UCAN revocation
handling shipped across v1.4.3–v1.4.5), so the published `web-sdk-wasm`/
`node-sdk-wasm` binaries move.

The vendored `@tinycloud/bootstrap` registry
(`src/generated/capabilities.ts`) is re-vendored byte-identical from
tinycloud-node@v1.4.5; the registry CONTENT (`REGISTRY_SOURCE_SHA256`,
`CAPABILITIES`, `ALIASES`, `IMPLICATIONS`) is unchanged — only the new
TC-121 `REGISTRY_SOURCE_REPO`/`REGISTRY_SOURCE_GIT_SHA` header exports and their
doc comments are added. The capabilities-sync CI now anchors its fetch-and-diff
to the explicit release-tag commit (`ANCHOR_NODE_REV`) rather than the header
sha (which, for a locally-generated artifact, names the generation parent and
would fetch the wrong artifact).
