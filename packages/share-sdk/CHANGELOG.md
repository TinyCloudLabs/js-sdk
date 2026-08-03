# @tinycloud/share-sdk

## 0.2.0-beta.2

### Patch Changes

- 7805213: Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
  versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
  artifact that predates the v3 APIs. Derive installed runtime-delegation
  provenance from signed UCAN authority and accept the node's canonical padded
  Base64 decrypt-response fields.
- Updated dependencies [7805213]
  - @tinycloud/share-envelope@0.2.0-beta.1

## 0.2.0-beta.0

### Minor Changes

- 2a77ebc: Add bounded Markdown bearer publishing plus stdin-safe Share inspect and receive commands backed by the canonical headless SDK.
- 9fd8752: Establish the canonical browser- and Node-safe Share envelope codecs and headless SDK foundation. Tracks TC-401's receiveShare parity contract.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.

### Patch Changes

- 17d5662: Pin addressed verification to an injected signer trust root, require detached node proof verification for authorized content, and keep Share command authority seams explicit and redacted.
- 705685e: Keep Share machine output redacted, make unavailable addressed revocation fail
  non-zero, and route browser consumers through the compiled receive contract.
- d4ec80a: Harden addressed Share content verification, restore CLI command dispatch and
  nonce-bound production upload authorization, and close filesystem and lifecycle
  edge cases in the Share command surface.
- 1103359: Route addressed Share verification through the canonical SDK, keep Node uploads fail-closed without explicit authority, and make the Share/help CLI entry independent of optional WASM authentication modules.
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/share-envelope@0.2.0-beta.0
