# @tinycloud/share-envelope

## 0.2.1-beta.0

### Patch Changes

- b0069f7: Add first-class accountless share receiving with session-key credential binding, strict PolicyCredentialPresentation/v4 admission, ordinary delegation invocation, and post-render private import into `files-for-you`.

## 0.2.0

### Minor Changes

- 9fd8752: Establish the canonical browser- and Node-safe Share envelope codecs and headless SDK foundation. Tracks TC-401's receiveShare parity contract.

### Patch Changes

- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.
- 7805213: Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
  versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
  artifact that predates the v3 APIs. Derive installed runtime-delegation
  provenance from signed UCAN authority and accept the node's canonical padded
  Base64 decrypt-response fields.

## 0.2.0-beta.1

### Patch Changes

- 7805213: Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
  versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
  artifact that predates the v3 APIs. Derive installed runtime-delegation
  provenance from signed UCAN authority and accept the node's canonical padded
  Base64 decrypt-response fields.

## 0.2.0-beta.0

### Minor Changes

- 9fd8752: Establish the canonical browser- and Node-safe Share envelope codecs and headless SDK foundation. Tracks TC-401's receiveShare parity contract.

### Patch Changes

- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.
