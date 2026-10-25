# @tinycloud/share-envelope

## 1.3.0

### Minor Changes

- 60b79d0: Add the `@tinycloud/share-envelope/links` subpath: typed, issuer-signed link records and the `#v=4` link grammar. It runs in browsers and in Node, using WebCrypto (`globalThis.crypto`) and `fetch` only.
  - Records: a strict signed header (type, issuer, audience, issuedAt, expiresAt, size, bodyCid, nonce), an Ed25519 signature over `SHA-256(domain ‖ JCS(header))`, and a sealed body. One body limit, `MAX_LINK_BODY_BYTES` (65,536 bytes), applies to every type; a body over it has neither a short nor a full link.
  - Signers: `createLink`, `deleteLink`, `prepareLinkRecord`, `signHeader` and `signDelete` take a `LinkSigner` (`{ did, sign(digest) }`), so the caller keeps its private key. `signerFromSeed` and `signerFromJwk` build one for tests and simple callers.
  - Links: `buildShortLink`, `buildFullLink`, `parseLink` (strict grammar, both forms) and `resolveLink` (the full reader pipeline, an optional `validateBody` hook, and one `LinkError` class with a `code` per refusal).
  - Delivery helpers: `shortShareLinkCid(href, { trustedOrigins })` gives the `c` of a short share link on one of the required `trustedOrigins` and `undefined` for any other string, including an id that is not lowercase; `DEFAULT_SHARE_ORIGINS` is the production share origin; `redactLink(text, href)` replaces a link and the key in its `k=` parameter in a text; `assertDidKeySignature(did, message, signature)` throws unless the signature, in its one canonical base64url spelling, verifies under the strict rule.
  - Verification: `verifyEd25519Strict` applies one Ed25519 rule everywhere (`S < ℓ`, canonical and prime-order `A` and `R`).
  - Strictness: a stored record, header or signature with an own key outside its field set (`__proto__` included) is refused before any copy is made, also on the short-link path; a `now` or date that is not a real time is refused with the `timestamp_format` `LinkError`; `isCanonicalRawCid`, exported by the package root and used by the links module, compares the string with a fresh encoding of the CID, so a trailing `=` is refused.
  - The `X-Link-Record` value of a short link must be the JCS text of its parsed value (`record_not_canonical`): a repeated key, white space, another key order or a key besides `header` and `signature` is refused.
  - The links vectors from the TC-1737 contract (`packages/share-envelope/test/links-api-vectors.json`, SHA-256 pinned in a test) drive the tests.
  - Packaging: the reader is its own file, `dist/links.js` (`dist/links.cjs`), built apart from `dist/index.js`. Its dependencies (`zod`, `@noble/curves`, `@noble/hashes`, `multiformats`) are package imports, so a bundler that already holds them adds no second copy.

  Removed:
  - The `@tinycloud/share-envelope/short-link` subpath and the `#v=3` codec (`SHORT_LINK_ID_PATTERN`, `parseShortShareUrl`, `splitInlineToShort`, `rebuildInlineFromShort`).
  - The inline `#v=2&p=` link codec (`encodeSealedInlineShareUrl`, `parseSealedInlineShareUrl` and their types).
  - The delete-token handling.
  - `test/shortlink-vectors.json`.

  The compact `/s/<cid>#k=` link (`encodeShareUrl`, `parseShareUrl`) is unchanged.

  Do not release before the deploy window for the links API, witness, node, Share web and CLI.

  Details: TC-1737

## 1.3.0-beta.0

### Minor Changes

- 60b79d0: Add the `@tinycloud/share-envelope/links` subpath: typed, issuer-signed link records and the `#v=4` link grammar. It runs in browsers and in Node, using WebCrypto (`globalThis.crypto`) and `fetch` only.
  - Records: a strict signed header (type, issuer, audience, issuedAt, expiresAt, size, bodyCid, nonce), an Ed25519 signature over `SHA-256(domain ‖ JCS(header))`, and a sealed body. One body limit, `MAX_LINK_BODY_BYTES` (65,536 bytes), applies to every type; a body over it has neither a short nor a full link.
  - Signers: `createLink`, `deleteLink`, `prepareLinkRecord`, `signHeader` and `signDelete` take a `LinkSigner` (`{ did, sign(digest) }`), so the caller keeps its private key. `signerFromSeed` and `signerFromJwk` build one for tests and simple callers.
  - Links: `buildShortLink`, `buildFullLink`, `parseLink` (strict grammar, both forms) and `resolveLink` (the full reader pipeline, an optional `validateBody` hook, and one `LinkError` class with a `code` per refusal).
  - Delivery helpers: `shortShareLinkCid(href, { trustedOrigins })` gives the `c` of a short share link on one of the required `trustedOrigins` and `undefined` for any other string, including an id that is not lowercase; `DEFAULT_SHARE_ORIGINS` is the production share origin; `redactLink(text, href)` replaces a link and the key in its `k=` parameter in a text; `assertDidKeySignature(did, message, signature)` throws unless the signature, in its one canonical base64url spelling, verifies under the strict rule.
  - Verification: `verifyEd25519Strict` applies one Ed25519 rule everywhere (`S < ℓ`, canonical and prime-order `A` and `R`).
  - Strictness: a stored record, header or signature with an own key outside its field set (`__proto__` included) is refused before any copy is made, also on the short-link path; a `now` or date that is not a real time is refused with the `timestamp_format` `LinkError`; `isCanonicalRawCid`, exported by the package root and used by the links module, compares the string with a fresh encoding of the CID, so a trailing `=` is refused.
  - The `X-Link-Record` value of a short link must be the JCS text of its parsed value (`record_not_canonical`): a repeated key, white space, another key order or a key besides `header` and `signature` is refused.
  - The links vectors from the TC-1737 contract (`packages/share-envelope/test/links-api-vectors.json`, SHA-256 pinned in a test) drive the tests.
  - Packaging: the reader is its own file, `dist/links.js` (`dist/links.cjs`), built apart from `dist/index.js`. Its dependencies (`zod`, `@noble/curves`, `@noble/hashes`, `multiformats`) are package imports, so a bundler that already holds them adds no second copy.

  Removed:
  - The `@tinycloud/share-envelope/short-link` subpath and the `#v=3` codec (`SHORT_LINK_ID_PATTERN`, `parseShortShareUrl`, `splitInlineToShort`, `rebuildInlineFromShort`).
  - The inline `#v=2&p=` link codec (`encodeSealedInlineShareUrl`, `parseSealedInlineShareUrl` and their types).
  - The delete-token handling.
  - `test/shortlink-vectors.json`.

  The compact `/s/<cid>#k=` link (`encodeShareUrl`, `parseShareUrl`) is unchanged.

  Do not release before the deploy window for the links API, witness, node, Share web and CLI.

  Details: TC-1737

## 1.2.1

### Patch Changes

- f8c2967: `tc share publish` prints addressed shares as a short link, `https://share.tinycloud.xyz/s/<id>#v=3&k=<key>&c=<cid>`, instead of a link of about 17,000 characters. Share's short-link service stores only the sealed envelope bytes. The read key and the CID of those bytes stay in the link's fragment: the service never receives the key, and `share receive`/`share inspect` refuse bytes that do not hash to the link's CID.
  - `--long-link` prints the long self-contained link instead.
  - If the short-link service is unavailable, publishing still succeeds. The CLI prints the long link and warns that it is long, and `--json` adds `shortLinkError`.
  - That includes refused connections, timeouts (10 seconds per request) and broken answers.
  - When the Share host itself can't be reached, publishing stops before anything is shared with `SHARE_SERVICE_UNAVAILABLE` (exit 4), instead of a message blaming the TinyCloud node.
  - `share show <id> --reveal-link` prints the same short link.
  - `share revoke` deletes the stored envelope after the node confirms the revocation. A failed delete only warns; the envelope expires with the share.
  - Sender history and the `--notify` invitation still carry the long link. Bearer links are unchanged.

  `@tinycloud/share-envelope` adds a `@tinycloud/share-envelope/short-link` subpath export with `parseShortShareUrl`, `splitInlineToShort` and `rebuildInlineFromShort`, tested against the vectors Share's own codec uses. They are not in the package root, so bundles that import the root (such as `@tinycloud/web-sdk`) do not grow. Details: TC-1737

## 1.2.1-beta.0

### Patch Changes

- f8c2967: `tc share publish` prints addressed shares as a short link, `https://share.tinycloud.xyz/s/<id>#v=3&k=<key>&c=<cid>`, instead of a link of about 17,000 characters. Share's short-link service stores only the sealed envelope bytes. The read key and the CID of those bytes stay in the link's fragment: the service never receives the key, and `share receive`/`share inspect` refuse bytes that do not hash to the link's CID.
  - `--long-link` prints the long self-contained link instead.
  - If the short-link service is unavailable, publishing still succeeds. The CLI prints the long link and warns that it is long, and `--json` adds `shortLinkError`.
  - That includes refused connections, timeouts (10 seconds per request) and broken answers.
  - When the Share host itself can't be reached, publishing stops before anything is shared with `SHARE_SERVICE_UNAVAILABLE` (exit 4), instead of a message blaming the TinyCloud node.
  - `share show <id> --reveal-link` prints the same short link.
  - `share revoke` deletes the stored envelope after the node confirms the revocation. A failed delete only warns; the envelope expires with the share.
  - Sender history and the `--notify` invitation still carry the long link. Bearer links are unchanged.

  `@tinycloud/share-envelope` adds a `@tinycloud/share-envelope/short-link` subpath export with `parseShortShareUrl`, `splitInlineToShort` and `rebuildInlineFromShort`, tested against the vectors Share's own codec uses. They are not in the package root, so bundles that import the root (such as `@tinycloud/web-sdk`) do not grow. Details: TC-1737

## 1.2.0

### Minor Changes

- 02c0a44: Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

  Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.

## 1.2.0-beta.0

### Minor Changes

- 02c0a44: Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

  Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.

## 1.1.0

### Minor Changes

- 6de6688: `tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

  `@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.

## 1.1.0-beta.0

### Minor Changes

- 6de6688: `tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

  `@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.

## 1.0.0

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.
- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

### Patch Changes

- b0069f7: Add first-class accountless share receiving with session-key credential binding, strict PolicyCredentialPresentation/v4 admission, ordinary delegation invocation, and post-render private import into `files-for-you`.
- dc92402: Use the browser-safe base64url codec when verifying compact UCAN roots, even when the host bundle exposes a partial `Buffer` polyfill.
- 026bf15: Ship browser-safe compact-UCAN verification and canonical embedded-policy delivery/receive with holder-bound delegation through generic `/delegate` and `/invoke`, without Node `/share/*`.
- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

## 1.0.0-beta.5

### Patch Changes

- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

## 1.0.0-beta.4

### Major Changes

- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

## 1.0.0-beta.3

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.

## 0.2.1-beta.2

### Patch Changes

- 026bf15: Ship browser-safe compact-UCAN verification and canonical embedded-policy delivery/receive with holder-bound delegation through generic `/delegate` and `/invoke`, without Node `/share/*`.

## 0.2.1-beta.1

### Patch Changes

- dc92402: Use the browser-safe base64url codec when verifying compact UCAN roots, even when the host bundle exposes a partial `Buffer` polyfill.

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
