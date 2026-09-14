# @tinycloud/share-sdk

## 1.0.0-beta.3

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.

### Patch Changes

- c690844: Reject addressed-share ciphertext whose exact owner-KV bytes do not match the
  signed source digest before key unwrap or rendering. Revoke addressed shares
  through the existing signed Policy/v3 root-revocation path, which cuts off
  active sessions as well as fresh admission and delivery.
- Updated dependencies [c690844]
  - @tinycloud/share-envelope@1.0.0-beta.3

## 0.3.0-beta.2

### Patch Changes

- 026bf15: Ship browser-safe compact-UCAN verification and canonical embedded-policy delivery/receive with holder-bound delegation through generic `/delegate` and `/invoke`, without Node `/share/*`.
- Updated dependencies [026bf15]
  - @tinycloud/share-envelope@0.2.1-beta.2

## 0.3.0-beta.1

### Patch Changes

- Updated dependencies [dc92402]
  - @tinycloud/share-envelope@0.2.1-beta.1

## 0.3.0-beta.0

### Minor Changes

- b0069f7: Add first-class accountless share receiving with session-key credential binding, strict PolicyCredentialPresentation/v4 admission, ordinary delegation invocation, and post-render private import into `files-for-you`.

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/share-envelope@0.2.1-beta.0

## 0.2.0

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
- 7805213: Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
  versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
  artifact that predates the v3 APIs. Derive installed runtime-delegation
  provenance from signed UCAN authority and accept the node's canonical padded
  Base64 decrypt-response fields.
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
- Updated dependencies [7805213]
  - @tinycloud/share-envelope@0.2.0

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
