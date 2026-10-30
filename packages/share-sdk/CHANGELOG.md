# @tinycloud/share-sdk

## 1.4.1

### Patch Changes

- e839be0: The share recipient checks a V3 source's wrapped-key digest by source kind. A path-bound source (`encryptionKeyPath`) must register the digest of the raw wrapped-key bytes, as before; a legacy no-path source must register the canonical hash of the base64 key, which the node accepts for that case. Shares made by stable CLI 1.4.0 and the old share composer open again. The invoke body, facts and response checks are unchanged.

  Details: TC-2242

- 812a818: Publish new CLI email shares as signed V3 Policy/v2 envelopes inside current v4 Share link records, with a unique exact `default/share/<shareId>` encryption key, a path-bound policy, and a committed email credential requirement. The `builtin:share-publishing` paste approval requests decrypt only for the owner's default-network `share/` prefix; device authorization and `enable share` omit decrypt. Existing V2 envelopes retain their read path.

  Details: TC-2177

- 0b024c2: Support named-key v2 recipient content with optional AAD, checking canonical wrapped-key hashes independently from registered decoded-byte digests and enforcing source bindings before decrypt requests. Validate ciphertext framing before requesting decryption and retain AAD when re-encrypting content.

  Details: TC-2192

- Updated dependencies [19048ec]
- Updated dependencies [812a818]
- Updated dependencies [7b22f61]
  - @tinycloud/share-envelope@1.4.0

## 1.4.1-beta.4

### Patch Changes

- e839be0: The share recipient checks a V3 source's wrapped-key digest by source kind. A path-bound source (`encryptionKeyPath`) must register the digest of the raw wrapped-key bytes, as before; a legacy no-path source must register the canonical hash of the base64 key, which the node accepts for that case. Shares made by stable CLI 1.4.0 and the old share composer open again. The invoke body, facts and response checks are unchanged.

  Details: TC-2242

## 1.4.1-beta.3

### Patch Changes

- Updated dependencies [19048ec]
  - @tinycloud/share-envelope@1.4.0-beta.2

## 1.4.1-beta.2

### Patch Changes

- 0b024c2: Support named-key v2 recipient content with optional AAD, checking canonical wrapped-key hashes independently from registered decoded-byte digests and enforcing source bindings before decrypt requests. Validate ciphertext framing before requesting decryption and retain AAD when re-encrypting content.

  Details: TC-2192

## 1.4.1-beta.1

### Patch Changes

- 812a818: Publish new CLI email shares as signed V3 Policy/v2 envelopes inside current v4 Share link records, with a unique exact `default/share/<shareId>` encryption key, a path-bound policy, and a committed email credential requirement. The `builtin:share-publishing` paste approval requests decrypt only for the owner's default-network `share/` prefix; device authorization and `enable share` omit decrypt. Existing V2 envelopes retain their read path.

  Details: TC-2177

- Updated dependencies [812a818]
  - @tinycloud/share-envelope@1.3.1-beta.1

## 1.4.1-beta.0

### Patch Changes

- Updated dependencies [7b22f61]
  - @tinycloud/share-envelope@1.3.1-beta.0

## 1.4.0

### Minor Changes

- 60b79d0: Addressed publish, receive, credential invitations, the sender index and `validateShareLink` use the `#v=4` link grammar of `@tinycloud/share-envelope/links`.
  - `publishAddressedShare` returns the full `v=4` link (`/s/full#v=4&k=…&r=…`), its header signed by the key that signs the envelope. `AddressedSharePublishOptions.apiOrigin` (default `https://api.tinycloud.xyz`) is the header's audience. A sealed envelope over `MAX_LINK_BODY_BYTES` fails with a `LinkError` (`body_over_cap`) and returns no link.
  - `inspectShare` and `receiveShare` resolve short and full links through `resolveLink`. `ShareFetchOptions` gains `apiOrigin` and `fetch`; `expectedOrigin` is the trusted viewer origin (default: the link's own origin).
  - `deliverCredentialInvitation` accepts only the short share link (lowercase id, at most 512 bytes).
  - `notifyShare` ends without a retry when the adapter throws an error with the code `delivery-authorization-invalid` (the node's refusal of a delivery authorization): the result is `partial-failure` with `attempts: 1` and `retryable: false`, as for HTTP 401 and 403.
  - `validateShareLink` returns the shape `"link"` for both `v=4` forms.
  - The share index keeps a short `v=4` link beside a record's delivery material and checks that it is the link of that material (`assertLinkBoundToMaterial`). A full link is not stored in an index record. `expandShareRecord(record)` takes no origin.
  - `inspectShare`, `receiveShare`, `publishAddressedShare` and `deliverCredentialInvitation` load `@tinycloud/share-envelope/links` with `import()` when they first need it. The package build keeps it a package import, so a bundle that embeds `@tinycloud/share-sdk` holds no links code.

  Removed:
  - The `"inline"` link shape and the inline `#v=2&p=` reader and writer calls.
  - `shareLinkForRecord` and the `shareOrigin` option of `AgentShareRecordStore`.

  Do not release before the deploy window for the links API, witness, node, Share web and CLI.

  Details: TC-1737

- 20bc8d1: A sender can measure an addressed share against the link size limit before it writes anything.
  - `addressedShareBodyUpperBound(input)` returns the largest sealed envelope the share can have, in bytes. It builds the envelope through the same serializer as `publishAddressedShare`, from the share's own inputs, with every value a write returns (root and registration identifiers, owner root authorizations, the enforcer's attestation, signatures, artifact version and digests) at its maximum encoded length, and seals it with a throwaway key. `assertAddressedShareFits(input)` throws a `SharePublishError` (`max-bytes-exceeded`, `ADDRESSED_SHARE_TOO_LARGE_MESSAGE`) when that is over `MAX_LINK_BODY_BYTES`.
  - `publishAddressedShare` runs the same check before its first write and fails with that `SharePublishError`. It then measures the sealed envelope itself before it builds a link; if that is over the limit it throws `AddressedShareOverLimitError`, whose `written` names the policy and the two owner roots it registered so the caller can remove them. No link is built.

  Do not release before the deploy window for the links API, witness, node, Share web and CLI.

  Details: TC-1737

### Patch Changes

- Updated dependencies [60b79d0]
  - @tinycloud/share-envelope@1.3.0

## 1.4.0-beta.0

### Minor Changes

- 60b79d0: Addressed publish, receive, credential invitations, the sender index and `validateShareLink` use the `#v=4` link grammar of `@tinycloud/share-envelope/links`.
  - `publishAddressedShare` returns the full `v=4` link (`/s/full#v=4&k=…&r=…`), its header signed by the key that signs the envelope. `AddressedSharePublishOptions.apiOrigin` (default `https://api.tinycloud.xyz`) is the header's audience. A sealed envelope over `MAX_LINK_BODY_BYTES` fails with a `LinkError` (`body_over_cap`) and returns no link.
  - `inspectShare` and `receiveShare` resolve short and full links through `resolveLink`. `ShareFetchOptions` gains `apiOrigin` and `fetch`; `expectedOrigin` is the trusted viewer origin (default: the link's own origin).
  - `deliverCredentialInvitation` accepts only the short share link (lowercase id, at most 512 bytes).
  - `notifyShare` ends without a retry when the adapter throws an error with the code `delivery-authorization-invalid` (the node's refusal of a delivery authorization): the result is `partial-failure` with `attempts: 1` and `retryable: false`, as for HTTP 401 and 403.
  - `validateShareLink` returns the shape `"link"` for both `v=4` forms.
  - The share index keeps a short `v=4` link beside a record's delivery material and checks that it is the link of that material (`assertLinkBoundToMaterial`). A full link is not stored in an index record. `expandShareRecord(record)` takes no origin.
  - `inspectShare`, `receiveShare`, `publishAddressedShare` and `deliverCredentialInvitation` load `@tinycloud/share-envelope/links` with `import()` when they first need it. The package build keeps it a package import, so a bundle that embeds `@tinycloud/share-sdk` holds no links code.

  Removed:
  - The `"inline"` link shape and the inline `#v=2&p=` reader and writer calls.
  - `shareLinkForRecord` and the `shareOrigin` option of `AgentShareRecordStore`.

  Do not release before the deploy window for the links API, witness, node, Share web and CLI.

  Details: TC-1737

- 20bc8d1: A sender can measure an addressed share against the link size limit before it writes anything.
  - `addressedShareBodyUpperBound(input)` returns the largest sealed envelope the share can have, in bytes. It builds the envelope through the same serializer as `publishAddressedShare`, from the share's own inputs, with every value a write returns (root and registration identifiers, owner root authorizations, the enforcer's attestation, signatures, artifact version and digests) at its maximum encoded length, and seals it with a throwaway key. `assertAddressedShareFits(input)` throws a `SharePublishError` (`max-bytes-exceeded`, `ADDRESSED_SHARE_TOO_LARGE_MESSAGE`) when that is over `MAX_LINK_BODY_BYTES`.
  - `publishAddressedShare` runs the same check before its first write and fails with that `SharePublishError`. It then measures the sealed envelope itself before it builds a link; if that is over the limit it throws `AddressedShareOverLimitError`, whose `written` names the policy and the two owner roots it registered so the caller can remove them. No link is built.

  Do not release before the deploy window for the links API, witness, node, Share web and CLI.

  Details: TC-1737

### Patch Changes

- Updated dependencies [60b79d0]
  - @tinycloud/share-envelope@1.3.0-beta.0

## 1.3.0

### Minor Changes

- 666f60b: Add the `@tinycloud/share-sdk/web-recipient` subpath. It exports `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type, so browser bundles can import the recipient surface without the package root barrel. The root barrel's exports are unchanged.

  Details: TC-1757

## 1.3.0-beta.0

### Minor Changes

- 666f60b: Add the `@tinycloud/share-sdk/web-recipient` subpath. It exports `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type, so browser bundles can import the recipient surface without the package root barrel. The root barrel's exports are unchanged.

  Details: TC-1757

## 1.2.1

### Patch Changes

- Updated dependencies [f8c2967]
  - @tinycloud/share-envelope@1.2.1

## 1.2.1-beta.0

### Patch Changes

- Updated dependencies [f8c2967]
  - @tinycloud/share-envelope@1.2.1-beta.0

## 1.2.0

### Minor Changes

- 9067edd: New subpath `@tinycloud/share-sdk/html-bundle`: the HTML folder rewriter the Share viewer carries (`prepareHtmlArtifact`, `canonicalArtifactPath`, `detectHtmlArtifact`, ...), moved here so the Share app and `tc share publish ./site/` use one implementation. Additive: the package root does not re-export it, so browser bundles that import the root do not grow.

  Changes against the viewer's reviewed `bundle.ts`, all stricter or additive (`assertSelfContainedPage` is the final pass: it reads the produced page again, with a tokenizer of its own and with the DOM parser, and refuses anything but `data:` URLs and `#fragment`s, and any attribute outside a text allow-list whose value reads as a URL; inline SVG `<script>`, `<xmp>`, `<plaintext>` and a `<script>` whose type is not JavaScript (`speculationrules`, `importmap`, ...) are refused; pages are limited to 20,000 comments and 5,000 attributes per element (`limit`); CSS escapes in `url`/`@import`/`image-set`/`src` are decoded before matching; `<noscript>`, `<area href>`, `ping`, SVG `url()` attributes and `<template>` content are handled; the 10 MiB output cap and a 2,000-reference cap are enforced as the page is built): `prepareHtmlArtifact(files, { parseHtml, singlePage })` (`parseHtml` supplies the HTML5 parser outside a browser; `singlePage` transforms only `index.html` and refuses links to other pages); an `ArtifactBundleError` now carries `path` and `reference` (untrusted text: escape before printing); inline SVG elements whose `href` / `xlink:href` is not a same-document `#fragment` are refused; the module-script check reads the `type` attribute so it behaves the same in every DOM. New: `inlineHtmlFolder(files)` inlines a folder into one self-contained document, and `isPassiveArtifactPath` / `InlinedHtmlFolder.passive` keep `manifest.json` and `knowledge/**` out of the page and return them untouched (the extension point for publishing an app manifest and knowledge bundle as sidecars).

- daf8561: Shared share index, SDK layer (TC-1432 design C, slice 2), published as the new subpath `@tinycloud/share-sdk/share-index`. Additive: the package root's runtime code is unchanged and does not re-export it, so browser bundles that import the root do not grow.
  - Record store: `WebShareRecordStore` (`records/<shareId>`, owner-network vault) and `AgentShareRecordStore` (`records/agents/<agentId>/<shareId>`), both `SenderShareRecordStorage`. `isShareId` is enforced on every operation; agent lists use the explicit prefix with its trailing slash.
  - Key classifier `classifyRecordKey`: rejects `%`, `\`, `.`/`..` and empty segments and a leading `/` before anything else; a rejected key inside an agent prefix is charged to that agent once (as a 16-character hash, never the agent's text).
  - Agent record codec: a fresh 32-byte data key and fresh nonces on every write, HKDF subkeys bound to the record location, a key commitment checked in constant time, and two wraps of the data key (`wrapAgent` under a key derived from the agent's signing key, `wrapOwner` to the owner network). The owner path refuses an owner wrap whose declared AAD is not the record's binding before any decrypt request, and zeroes the data key on every path. Records larger than `MAX_AGENT_RECORD_BYTES` (32 KiB) are refused.
  - Stored form, each blob once: `AgentShareRecordStore.put` stores a Policy/v3 record without `deliveryMaterial.envelope` and its `/s/inline` link (`compactShareRecord`, after checking both are exactly what the sealed material rebuilds), and the reconciler refuses an agent record that stores either again. `openDeliveryEnvelope` (the verifier opens the envelope from `sealedEnvelope`, bound to `shareCid`), `shareLinkForRecord` (the link rebuilt at Open/Copy) and `expandShareRecord` (the full record back). A real CLI v3 record is about 29.5 KB stored, under the 32 KiB cap.
  - The adapter sends the record cap as the KV `maxResponseBytes`, so the node refuses an oversize agent value (413) before sending its body; `readRaw(key, maxBytes)` reports it `too_large` and the reconciler rejects it `size`.
  - Record times are RFC 3339 UTC with or without a fraction, as `publishAddressedShare` writes them.
  - Chain verifier `verifyAgentRecordChain` (bearer link delegations, Policy/v3 envelopes, Policy/v2 owner policies) with proof states `proven` / `chained` / `unproven`, a separate `expired` flag, and the signed issuance window `registeredAt` is checked against (link `nbf`, the session's `Issued At`, the v3 binding's `issuedAt`, the node's v2 `registeredAt`). Precedence web > proven > chained > unproven in any arrival order (`decideClaim`). New verifiers: signed UCAN parsing with `prf`/`nbf`/`exp`, attenuation containment, owner→session SIWE checks (time window, issuer = account owner, audience = delegation issuer), a Policy/v2 enforcement-delegation signature verifier, `checkRegistrationReceipt` (a Policy/v2 node registration with expired reported apart from invalid), and `verifyEnvelopeV3At` (Policy/v3 verification at an explicit time, so an expired share is reported as Expired).
  - A record's content may live in any space of the account owner (`isSpaceOwnedBy`); the records stay in `applications`.
  - `provenance: "migrated"` (one-time owner import, row `pv: "migrated"`) is accepted only at owner-layout keys: it is exempt from the ±1-day `registeredAt` anchor and nothing else, ranks by its proof state, and never displaces a node-confirmed revocation. A record in `records/agents/<id>/` claiming it is rejected (`provenance`).
  - `SenderShareIndex`: the encrypted display-only index at `records/_index/main` with compare-and-swap writes, an outbox interface, the budgeted reconciler with the §5 checks (every agent fetch spends its 50-per-pass allowance), per-agent rejected lists, caps and pause, status sync, compaction into `records/_index/archive-<yyyy>` and header garbage collection. A full header stops new agent state (`headerFull`) but never blocks the owner's own ops or evicts rows. A refused ETag (`INVALID_ETAG`, for example one weakened in transit) throws `ShareIndexCasError` on its first occurrence and is never retried.
  - Reference: `docs/share-index.md`, including what revocation does today: the owner wallet's generic `/revoke` of a v3 root ends that share at once (open recipient sessions included); revoking an agent's session kills its bearer links and new v3 claims, while an already-open v3 recipient session keeps reading for its lifetime until the node liveness check (N3).
  - SIWE `Not Before` and `Issued At` are read from the CACAO bytes the injected parser (sdk-core `parseSignedSiweCacao`) has verified; sdk-core and share-envelope are unchanged.

- e68e911: Per-share encryption networks in `@tinycloud/share-sdk/share-root` (TC-1423 D3). Every addressed (email/domain) or edit share now has its own network, `urn:tinycloud:encryption:<owner did:pkh, lowercase>:share-<shareId>`, so a key or recipient holding decrypt reaches that one share only. The main entry is unchanged.

  Removed (allowed between betas; these shipped only in prereleases):
  - `ShareRoot` no longer has a decrypt scope: `ShareRootScope`, `root.scope`, `root.policyCapable`, `root.policyRootSigner()`, the `shareRootPolicyRoots` and `policyOwnerModeProbe` options, `ensureShareRoot`'s `purpose`, and the owner-authority probe (`POLICY_OWNER_AUTHORITY_FEATURES`, `POLICY_OWNER_AUTHORITY_PROBE_TTL_MS`, `readPolicyOwnerAuthorityMode`, `PolicyOwnerModeProbe`, `createPolicyOwnerModeProbe`, `defaultPolicyOwnerModeProbe`) are removed, with the error codes `policy-roots-disabled`, `policy-roots-not-enforced-by-node` and `root-not-policy-capable`. A share root is kv/bearer only, before and after the Node enforces owner-authority binding; the root record no longer has `scope`.
  - The owner-wide `:share` network is gone from the SDK: `ensureShareNetwork`, `shareNetworkIdFor` and `ShareNetworkResult` are removed.
  - `ShareRootPolicySigner` is renamed `SharePolicySigner`.
  - `ShareGrantRecord` is now version 2 (`shareId`, `networkId`); version 1 records are refused by `ShareGrant.restore`.

  Added:
  - `perShareNetworkIdFor(ownerDid, shareId)` and `assertNetworkSafeShareId`: a shareId must match `^[a-z0-9][a-z0-9-]{15,35}$` (UUIDs and 32-hex ids do), checked before any prompt (`share-id-not-network-safe`).
  - `ShareGrant.prepare(...)` (all checks, a network lookup, the key, and a `pending` row to persist before the prompt) then `pending.approve()`: one approval for kv `get` + `metadata` (+ `put` for `edit`) on the share's one key (`xyz.tinycloud.share/shares/<shareId>/<file>`, or for `view` only a TC-1428 version file) and `network.create`, `network.revoke`, `decrypt` on the share's network only. A shareId whose network already exists or was retired is refused before the prompt (`share-id-in-use`; `resumeExistingNetwork` accepts an active one for key-gone recovery). `ShareGrant.create` does both. A signed grant that is only narrower than requested is refused without `mustRevoke`.
  - `grant.ensureNetwork()` creates the network with the per-share key (no approval) and accepts it only after a fresh lookup shows it `active` with the expected owner, name, algorithm, key version 1 and threshold 1/1; a retired network is never re-created. `grant.publishAuthority(registerPolicy)` re-reads the network as `active` before every registration; `grant.assertContentSource` checks the stored object is this share's. `grant.row(state)` gives the history row for each publish step.
  - `grant.retireNetwork()` retires the network (permanent; every holder of decrypt is refused at the next request; idempotent; no approval). `revokeShareGrant` retires first, then revokes the grant with one owner SIWE; if that fails the error `grant-revoke-incomplete` says decrypt is already cut.
  - `openEditShare`: the owner reads back an edit share with one approval, to an in-memory key that lives at most one hour.
  - Owner kill-all: `planShareControlBatches` splits shares into owner controls sized by the exact `Authorization` bytes, at most `SHARE_CONTROL_HEADER_BUDGET_BYTES` (30,000; the production ingress refuses values above 32,751 bytes): 34 shares per control with the `applications`/`default` delegation rows, which every control carries. Targets must be the owner's per-share networks (`share-<shareId>`); `:default`, `:share` or any other network is refused (`control-target-invalid`) before anything is signed, in planning and again in `runShareControlBatch`, which also re-checks the domain, space rows and byte budget of the batch it is given. `runShareControlBatch` signs one control (one approval), retires every network first, then revokes each grant through the control, counting only a `{ revoked: true, cid }` receipt. A kill-all of L shares costs ceil(L/34) approvals on v1.20.6 and NODE-B2 N4' (measured live across two controls); 1.21.0 and N1b refuse control revokes of decrypt-bearing grants, so with `revokeFallback` each grant costs one more owner SIWE (ceil(L/34) + L).

- 6e7ad8f: Add bearer links via the share root to `@tinycloud/share-sdk/share-root` (TC-1423 D3, slice 3). The main entry is unchanged.
  - `publishRootBearerLink({ root, path, expiresAt, viewerOrigin })` mints a view-only link with no owner approval: the share key signs `kv/get` on one exact key under `xyz.tinycloud.share/shares/` (never beyond the root, never more than 30 days, exactly the requested expiry to the second), the Node imports it, and the link is encoded exactly like today's SharingService links (`/viewer#tc1=<token>`, the token carrying a fresh per-link key and its delegation), so the viewer and `openNativeShare` open it unchanged. Use `ensureShareRoot` first; a re-root costs one approval.
  - `revokeRootBearerLink({ root, delegationCid })` revokes one link with the share key that issued it (no approval) and accepts only a matching `{ revoked: true, cid }` receipt; the owner can revoke the same CID with an owner SIWE (one approval). `ShareRoot.signLinkRevocation` signs that request and refuses the root's own CID.
  - A Node refusing a link delegation or revocation (for example after the root was revoked: re-root) throws `node-refused`.

- d84e379: Add the owner's `:share` network and per-share grants to `@tinycloud/share-sdk/share-root` (TC-1423 D3, slice 2). The main entry is unchanged.
  - `ensureShareNetwork` makes sure the owner-owned `urn:tinycloud:encryption:<owner did:pkh>:share` network exists (`shareNetworkIdFor` names it). When it exists, nothing is signed. Otherwise the owner approves one 10-minute CACAO granting only `network.create` on that URN to a throwaway non-extractable key, which creates the network with the owner as owner and is then cleared. The signed grant is decoded and must match exactly. Share and per-share keys never own a network.
  - `ShareGrant.create` asks the owner for one approval per addressed (email/domain) or edit share: a CACAO to a fresh non-extractable per-share key granting kv `get` + `metadata` (+ `put` for `edit`) on exactly one key under `xyz.tinycloud.share/shares/`, plus `decrypt` on the owner's `:share` network (a Policy/v3 owner must hold decrypt on the source's network), for at most 30 days. Broader paths, longer expiries, other spaces or access levels are refused before the wallet prompt; the signed CACAO is decoded and must match exactly, or the key is cleared and the error carries the CID with `mustRevoke`.
  - `ShareGrant.publishAuthority(registerPolicy)` is the `publishAddressedShare` authority for that one share: policy roots owned by the per-share key, no later than the grant, naming only its exact key (no action the grant lacks) and `:share` decrypt; 32-byte digests only. `restore` rebuilds a grant from a CLI-held key; no browser persistence.
  - The owner revokes one share by revoking its grant (one approval); other shares are untouched. Until the Node binds policy registrations to the owner delegation, an already-registered policy keeps admitting recipients until its own expiry, which never exceeds the grant's.
  - Wording: a `kv` share root's key cannot own a policy over `:share`-encrypted content (the Node answers `policy-owner-not-authorized`).

- c2fd94b: Add `ShareRoot` (TC-1423 D3, slice 1) under the new subpath `@tinycloud/share-sdk/share-root` (the main entry is unchanged, so its consumers' bundles do not grow): a wallet-signed, read-only root delegated to one non-extractable Ed25519 share key, so shares can outlive the owner's login session.
  - `ShareRoot.create` asks the owner once through `createOwnerDelegation({ permissions })`. The scope is chosen at creation from the Node's advertised owner-authority mode: `kv` (get + metadata on `xyz.tinycloud.share/shares/` in `applications`) unless the `shareRootPolicyRoots` option is on and the Node's `GET /info` `features` list `policy-owner-authority-v1` + `policy-owner-authority-enforce`, in which case decrypt on the owner's `:share` network is added (`kv+share-decrypt`). Agent roots are always `kv`, in `default`. The scope and the Node origin are kept in the root record.
  - The signed CACAO is decoded and anything else is rejected: other abilities or caveats, other resources, a parent, another audience or owner, a lifetime over 37 days (agents: 30; up to 5 minutes of signer clock skew on the issue time), or an expiry other than the one requested. The key is cleared, and the error carries the imported CID, the CID of the signed bytes when they differ, and `mustRevoke` when the imported root may grant more than requested.
  - `create` generates the key itself and never exposes it; `clear()` drops the only handle. Browser persistence of a share key is not provided and needs the composer on its own origin first.
  - `signBearerLink` signs a `kv/get` link on one exact key under the prefix, outside WASM; it never outlives the root or 30 days.
  - `policyRootSigner` is the only ShareRoot API that signs Policy/v3 owner material. It needs a `kv+share-decrypt` root and the flag, and its `createOwnerRoot` / `sign` (32-byte digests only) re-check the flag, the root's expiry and the Node's advertised mode on every call. Policy roots are built by the signer and may not outlive the share root. A share key holder can still sign through other APIs; the Node refuses a policy registered by a `kv` root's key (`policy-owner-not-authorized`).
  - `ensureShareRoot` re-roots (new key, one approval, the cap minus 10 minutes) only when the current root does not cover the requested expiry, or, for `purpose: "policy"`, when the Node enforces and the current root is `kv`. It never returns a `kv` root for policy use.
  - `createPolicyOwnerModeProbe` caches each Node's answer for at most 5 minutes, probes only https (http on loopback), requires a JSON answer of at most 64 KiB, and accepts the features a sign-in already read (`observe`); any failure counts as not enforcing.
  - `signShareKeyDelegation`, `assertNonExtractableShareKey`, `decodeOwnerRootCacao` and `ownerRootCacaoCid` are exported for these flows.

- 02c0a44: Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

  Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.

- 116b214: Artifact versions for `share publish` (TC-1428). `share publish --artifact <id|new>` stores the file as a write-once version under `artifacts/<id>/versions/<n>/` (created with `If-None-Match: *`, `manifest.json` written last) in the owner's space and pins the share to that version: bearer and addressed shares read one version file and never carry `put`. Re-publishing the same bytes to a bearer link returns the same version and changed content makes the next, so an agent retry is safe. An addressed share is a fresh encryption each time, so each is its own version; the manifest records only the sha256 of the stored bytes, never of the plaintext. `share versions <id>` lists versions and the shares pinned to each. `--action edit` on an artifact share is refused; every artifact share pins one version. The layout helpers (`publishArtifactVersion`, `listArtifactVersions`, `parseArtifactManifest`, path helpers) are a new `@tinycloud/share-sdk/artifact` entry point, kept out of the main barrel so browser bundles do not carry them. No node change.

  The built-in `builtin:share-publishing` manifest now also requests `artifacts/` (get, metadata, put, list). Profiles signed in before this version must sign in again to use `--artifact` (`auth login --device --manifest builtin:share-publishing`); other `share publish` use is unchanged. Versions are kept by default and count against the owner's storage; reclaiming bytes depends on history GC (TC-1277).

### Patch Changes

- Updated dependencies [02c0a44]
  - @tinycloud/share-envelope@1.2.0

## 1.2.0-beta.7

### Minor Changes

- 9067edd: New subpath `@tinycloud/share-sdk/html-bundle`: the HTML folder rewriter the Share viewer carries (`prepareHtmlArtifact`, `canonicalArtifactPath`, `detectHtmlArtifact`, ...), moved here so the Share app and `tc share publish ./site/` use one implementation. Additive: the package root does not re-export it, so browser bundles that import the root do not grow.

  Changes against the viewer's reviewed `bundle.ts`, all stricter or additive (`assertSelfContainedPage` is the final pass: it reads the produced page again, with a tokenizer of its own and with the DOM parser, and refuses anything but `data:` URLs and `#fragment`s, and any attribute outside a text allow-list whose value reads as a URL; inline SVG `<script>`, `<xmp>`, `<plaintext>` and a `<script>` whose type is not JavaScript (`speculationrules`, `importmap`, ...) are refused; pages are limited to 20,000 comments and 5,000 attributes per element (`limit`); CSS escapes in `url`/`@import`/`image-set`/`src` are decoded before matching; `<noscript>`, `<area href>`, `ping`, SVG `url()` attributes and `<template>` content are handled; the 10 MiB output cap and a 2,000-reference cap are enforced as the page is built): `prepareHtmlArtifact(files, { parseHtml, singlePage })` (`parseHtml` supplies the HTML5 parser outside a browser; `singlePage` transforms only `index.html` and refuses links to other pages); an `ArtifactBundleError` now carries `path` and `reference` (untrusted text: escape before printing); inline SVG elements whose `href` / `xlink:href` is not a same-document `#fragment` are refused; the module-script check reads the `type` attribute so it behaves the same in every DOM. New: `inlineHtmlFolder(files)` inlines a folder into one self-contained document, and `isPassiveArtifactPath` / `InlinedHtmlFolder.passive` keep `manifest.json` and `knowledge/**` out of the page and return them untouched (the extension point for publishing an app manifest and knowledge bundle as sidecars).

## 1.2.0-beta.6

### Minor Changes

- 6e7ad8f: Add bearer links via the share root to `@tinycloud/share-sdk/share-root` (TC-1423 D3, slice 3). The main entry is unchanged.
  - `publishRootBearerLink({ root, path, expiresAt, viewerOrigin })` mints a view-only link with no owner approval: the share key signs `kv/get` on one exact key under `xyz.tinycloud.share/shares/` (never beyond the root, never more than 30 days, exactly the requested expiry to the second), the Node imports it, and the link is encoded exactly like today's SharingService links (`/viewer#tc1=<token>`, the token carrying a fresh per-link key and its delegation), so the viewer and `openNativeShare` open it unchanged. Use `ensureShareRoot` first; a re-root costs one approval.
  - `revokeRootBearerLink({ root, delegationCid })` revokes one link with the share key that issued it (no approval) and accepts only a matching `{ revoked: true, cid }` receipt; the owner can revoke the same CID with an owner SIWE (one approval). `ShareRoot.signLinkRevocation` signs that request and refuses the root's own CID.
  - A Node refusing a link delegation or revocation (for example after the root was revoked: re-root) throws `node-refused`.

## 1.2.0-beta.5

### Minor Changes

- 02c0a44: Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

  Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.

### Patch Changes

- Updated dependencies [02c0a44]
  - @tinycloud/share-envelope@1.2.0-beta.0

## 1.2.0-beta.4

### Minor Changes

- daf8561: Shared share index, SDK layer (TC-1432 design C, slice 2), published as the new subpath `@tinycloud/share-sdk/share-index`. Additive: the package root's runtime code is unchanged and does not re-export it, so browser bundles that import the root do not grow.
  - Record store: `WebShareRecordStore` (`records/<shareId>`, owner-network vault) and `AgentShareRecordStore` (`records/agents/<agentId>/<shareId>`), both `SenderShareRecordStorage`. `isShareId` is enforced on every operation; agent lists use the explicit prefix with its trailing slash.
  - Key classifier `classifyRecordKey`: rejects `%`, `\`, `.`/`..` and empty segments and a leading `/` before anything else; a rejected key inside an agent prefix is charged to that agent once (as a 16-character hash, never the agent's text).
  - Agent record codec: a fresh 32-byte data key and fresh nonces on every write, HKDF subkeys bound to the record location, a key commitment checked in constant time, and two wraps of the data key (`wrapAgent` under a key derived from the agent's signing key, `wrapOwner` to the owner network). The owner path refuses an owner wrap whose declared AAD is not the record's binding before any decrypt request, and zeroes the data key on every path. Records larger than `MAX_AGENT_RECORD_BYTES` (32 KiB) are refused.
  - Stored form, each blob once: `AgentShareRecordStore.put` stores a Policy/v3 record without `deliveryMaterial.envelope` and its `/s/inline` link (`compactShareRecord`, after checking both are exactly what the sealed material rebuilds), and the reconciler refuses an agent record that stores either again. `openDeliveryEnvelope` (the verifier opens the envelope from `sealedEnvelope`, bound to `shareCid`), `shareLinkForRecord` (the link rebuilt at Open/Copy) and `expandShareRecord` (the full record back). A real CLI v3 record is about 29.5 KB stored, under the 32 KiB cap.
  - The adapter sends the record cap as the KV `maxResponseBytes`, so the node refuses an oversize agent value (413) before sending its body; `readRaw(key, maxBytes)` reports it `too_large` and the reconciler rejects it `size`.
  - Record times are RFC 3339 UTC with or without a fraction, as `publishAddressedShare` writes them.
  - Chain verifier `verifyAgentRecordChain` (bearer link delegations, Policy/v3 envelopes, Policy/v2 owner policies) with proof states `proven` / `chained` / `unproven`, a separate `expired` flag, and the signed issuance window `registeredAt` is checked against (link `nbf`, the session's `Issued At`, the v3 binding's `issuedAt`, the node's v2 `registeredAt`). Precedence web > proven > chained > unproven in any arrival order (`decideClaim`). New verifiers: signed UCAN parsing with `prf`/`nbf`/`exp`, attenuation containment, owner→session SIWE checks (time window, issuer = account owner, audience = delegation issuer), a Policy/v2 enforcement-delegation signature verifier, `checkRegistrationReceipt` (a Policy/v2 node registration with expired reported apart from invalid), and `verifyEnvelopeV3At` (Policy/v3 verification at an explicit time, so an expired share is reported as Expired).
  - A record's content may live in any space of the account owner (`isSpaceOwnedBy`); the records stay in `applications`.
  - `provenance: "migrated"` (one-time owner import, row `pv: "migrated"`) is accepted only at owner-layout keys: it is exempt from the ±1-day `registeredAt` anchor and nothing else, ranks by its proof state, and never displaces a node-confirmed revocation. A record in `records/agents/<id>/` claiming it is rejected (`provenance`).
  - `SenderShareIndex`: the encrypted display-only index at `records/_index/main` with compare-and-swap writes, an outbox interface, the budgeted reconciler with the §5 checks (every agent fetch spends its 50-per-pass allowance), per-agent rejected lists, caps and pause, status sync, compaction into `records/_index/archive-<yyyy>` and header garbage collection. A full header stops new agent state (`headerFull`) but never blocks the owner's own ops or evicts rows. A refused ETag (`INVALID_ETAG`, for example one weakened in transit) throws `ShareIndexCasError` on its first occurrence and is never retried.
  - Reference: `docs/share-index.md`, including what revocation does today: the owner wallet's generic `/revoke` of a v3 root ends that share at once (open recipient sessions included); revoking an agent's session kills its bearer links and new v3 claims, while an already-open v3 recipient session keeps reading for its lifetime until the node liveness check (N3).
  - SIWE `Not Before` and `Issued At` are read from the CACAO bytes the injected parser (sdk-core `parseSignedSiweCacao`) has verified; sdk-core and share-envelope are unchanged.

## 1.2.0-beta.3

### Minor Changes

- e68e911: Per-share encryption networks in `@tinycloud/share-sdk/share-root` (TC-1423 D3). Every addressed (email/domain) or edit share now has its own network, `urn:tinycloud:encryption:<owner did:pkh, lowercase>:share-<shareId>`, so a key or recipient holding decrypt reaches that one share only. The main entry is unchanged.

  Removed (allowed between betas; these shipped only in prereleases):
  - `ShareRoot` no longer has a decrypt scope: `ShareRootScope`, `root.scope`, `root.policyCapable`, `root.policyRootSigner()`, the `shareRootPolicyRoots` and `policyOwnerModeProbe` options, `ensureShareRoot`'s `purpose`, and the owner-authority probe (`POLICY_OWNER_AUTHORITY_FEATURES`, `POLICY_OWNER_AUTHORITY_PROBE_TTL_MS`, `readPolicyOwnerAuthorityMode`, `PolicyOwnerModeProbe`, `createPolicyOwnerModeProbe`, `defaultPolicyOwnerModeProbe`) are removed, with the error codes `policy-roots-disabled`, `policy-roots-not-enforced-by-node` and `root-not-policy-capable`. A share root is kv/bearer only, before and after the Node enforces owner-authority binding; the root record no longer has `scope`.
  - The owner-wide `:share` network is gone from the SDK: `ensureShareNetwork`, `shareNetworkIdFor` and `ShareNetworkResult` are removed.
  - `ShareRootPolicySigner` is renamed `SharePolicySigner`.
  - `ShareGrantRecord` is now version 2 (`shareId`, `networkId`); version 1 records are refused by `ShareGrant.restore`.

  Added:
  - `perShareNetworkIdFor(ownerDid, shareId)` and `assertNetworkSafeShareId`: a shareId must match `^[a-z0-9][a-z0-9-]{15,35}$` (UUIDs and 32-hex ids do), checked before any prompt (`share-id-not-network-safe`).
  - `ShareGrant.prepare(...)` (all checks, a network lookup, the key, and a `pending` row to persist before the prompt) then `pending.approve()`: one approval for kv `get` + `metadata` (+ `put` for `edit`) on the share's one key (`xyz.tinycloud.share/shares/<shareId>/<file>`, or for `view` only a TC-1428 version file) and `network.create`, `network.revoke`, `decrypt` on the share's network only. A shareId whose network already exists or was retired is refused before the prompt (`share-id-in-use`; `resumeExistingNetwork` accepts an active one for key-gone recovery). `ShareGrant.create` does both. A signed grant that is only narrower than requested is refused without `mustRevoke`.
  - `grant.ensureNetwork()` creates the network with the per-share key (no approval) and accepts it only after a fresh lookup shows it `active` with the expected owner, name, algorithm, key version 1 and threshold 1/1; a retired network is never re-created. `grant.publishAuthority(registerPolicy)` re-reads the network as `active` before every registration; `grant.assertContentSource` checks the stored object is this share's. `grant.row(state)` gives the history row for each publish step.
  - `grant.retireNetwork()` retires the network (permanent; every holder of decrypt is refused at the next request; idempotent; no approval). `revokeShareGrant` retires first, then revokes the grant with one owner SIWE; if that fails the error `grant-revoke-incomplete` says decrypt is already cut.
  - `openEditShare`: the owner reads back an edit share with one approval, to an in-memory key that lives at most one hour.
  - Owner kill-all: `planShareControlBatches` splits shares into owner controls sized by the exact `Authorization` bytes, at most `SHARE_CONTROL_HEADER_BUDGET_BYTES` (30,000; the production ingress refuses values above 32,751 bytes): 34 shares per control with the `applications`/`default` delegation rows, which every control carries. Targets must be the owner's per-share networks (`share-<shareId>`); `:default`, `:share` or any other network is refused (`control-target-invalid`) before anything is signed, in planning and again in `runShareControlBatch`, which also re-checks the domain, space rows and byte budget of the batch it is given. `runShareControlBatch` signs one control (one approval), retires every network first, then revokes each grant through the control, counting only a `{ revoked: true, cid }` receipt. A kill-all of L shares costs ceil(L/34) approvals on v1.20.6 and NODE-B2 N4' (measured live across two controls); 1.21.0 and N1b refuse control revokes of decrypt-bearing grants, so with `revokeFallback` each grant costs one more owner SIWE (ceil(L/34) + L).

## 1.2.0-beta.2

### Minor Changes

- d84e379: Add the owner's `:share` network and per-share grants to `@tinycloud/share-sdk/share-root` (TC-1423 D3, slice 2). The main entry is unchanged.
  - `ensureShareNetwork` makes sure the owner-owned `urn:tinycloud:encryption:<owner did:pkh>:share` network exists (`shareNetworkIdFor` names it). When it exists, nothing is signed. Otherwise the owner approves one 10-minute CACAO granting only `network.create` on that URN to a throwaway non-extractable key, which creates the network with the owner as owner and is then cleared. The signed grant is decoded and must match exactly. Share and per-share keys never own a network.
  - `ShareGrant.create` asks the owner for one approval per addressed (email/domain) or edit share: a CACAO to a fresh non-extractable per-share key granting kv `get` + `metadata` (+ `put` for `edit`) on exactly one key under `xyz.tinycloud.share/shares/`, plus `decrypt` on the owner's `:share` network (a Policy/v3 owner must hold decrypt on the source's network), for at most 30 days. Broader paths, longer expiries, other spaces or access levels are refused before the wallet prompt; the signed CACAO is decoded and must match exactly, or the key is cleared and the error carries the CID with `mustRevoke`.
  - `ShareGrant.publishAuthority(registerPolicy)` is the `publishAddressedShare` authority for that one share: policy roots owned by the per-share key, no later than the grant, naming only its exact key (no action the grant lacks) and `:share` decrypt; 32-byte digests only. `restore` rebuilds a grant from a CLI-held key; no browser persistence.
  - The owner revokes one share by revoking its grant (one approval); other shares are untouched. Until the Node binds policy registrations to the owner delegation, an already-registered policy keeps admitting recipients until its own expiry, which never exceeds the grant's.
  - Wording: a `kv` share root's key cannot own a policy over `:share`-encrypted content (the Node answers `policy-owner-not-authorized`).

## 1.2.0-beta.1

### Minor Changes

- c2fd94b: Add `ShareRoot` (TC-1423 D3, slice 1) under the new subpath `@tinycloud/share-sdk/share-root` (the main entry is unchanged, so its consumers' bundles do not grow): a wallet-signed, read-only root delegated to one non-extractable Ed25519 share key, so shares can outlive the owner's login session.
  - `ShareRoot.create` asks the owner once through `createOwnerDelegation({ permissions })`. The scope is chosen at creation from the Node's advertised owner-authority mode: `kv` (get + metadata on `xyz.tinycloud.share/shares/` in `applications`) unless the `shareRootPolicyRoots` option is on and the Node's `GET /info` `features` list `policy-owner-authority-v1` + `policy-owner-authority-enforce`, in which case decrypt on the owner's `:share` network is added (`kv+share-decrypt`). Agent roots are always `kv`, in `default`. The scope and the Node origin are kept in the root record.
  - The signed CACAO is decoded and anything else is rejected: other abilities or caveats, other resources, a parent, another audience or owner, a lifetime over 37 days (agents: 30; up to 5 minutes of signer clock skew on the issue time), or an expiry other than the one requested. The key is cleared, and the error carries the imported CID, the CID of the signed bytes when they differ, and `mustRevoke` when the imported root may grant more than requested.
  - `create` generates the key itself and never exposes it; `clear()` drops the only handle. Browser persistence of a share key is not provided and needs the composer on its own origin first.
  - `signBearerLink` signs a `kv/get` link on one exact key under the prefix, outside WASM; it never outlives the root or 30 days.
  - `policyRootSigner` is the only ShareRoot API that signs Policy/v3 owner material. It needs a `kv+share-decrypt` root and the flag, and its `createOwnerRoot` / `sign` (32-byte digests only) re-check the flag, the root's expiry and the Node's advertised mode on every call. Policy roots are built by the signer and may not outlive the share root. A share key holder can still sign through other APIs; the Node refuses a policy registered by a `kv` root's key (`policy-owner-not-authorized`).
  - `ensureShareRoot` re-roots (new key, one approval, the cap minus 10 minutes) only when the current root does not cover the requested expiry, or, for `purpose: "policy"`, when the Node enforces and the current root is `kv`. It never returns a `kv` root for policy use.
  - `createPolicyOwnerModeProbe` caches each Node's answer for at most 5 minutes, probes only https (http on loopback), requires a JSON answer of at most 64 KiB, and accepts the features a sign-in already read (`observe`); any failure counts as not enforcing.
  - `signShareKeyDelegation`, `assertNonExtractableShareKey`, `decodeOwnerRootCacao` and `ownerRootCacaoCid` are exported for these flows.

## 1.2.0-beta.0

### Minor Changes

- 116b214: Artifact versions for `share publish` (TC-1428). `share publish --artifact <id|new>` stores the file as a write-once version under `artifacts/<id>/versions/<n>/` (created with `If-None-Match: *`, `manifest.json` written last) in the owner's space and pins the share to that version: bearer and addressed shares read one version file and never carry `put`. Re-publishing the same bytes to a bearer link returns the same version and changed content makes the next, so an agent retry is safe. An addressed share is a fresh encryption each time, so each is its own version; the manifest records only the sha256 of the stored bytes, never of the plaintext. `share versions <id>` lists versions and the shares pinned to each. `--action edit` on an artifact share is refused; every artifact share pins one version. The layout helpers (`publishArtifactVersion`, `listArtifactVersions`, `parseArtifactManifest`, path helpers) are a new `@tinycloud/share-sdk/artifact` entry point, kept out of the main barrel so browser bundles do not carry them. No node change.

  The built-in `builtin:share-publishing` manifest now also requests `artifacts/` (get, metadata, put, list). Profiles signed in before this version must sign in again to use `--artifact` (`auth login --device --manifest builtin:share-publishing`); other `share publish` use is unchanged. Versions are kept by default and count against the owner's storage; reclaiming bytes depends on history GC (TC-1277).

## 1.1.1

### Patch Changes

- c13720c: `tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.
  - **Error codes for bearer revokes.**
    - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
    - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
    - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
    - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
  - **History.** Revoking an already revoked share keeps its original `revokedAt`.
  - **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
  - **sdk-core.** These are additions only:
    - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
    - The new `parseSignedSiweCacao(authorization, expectedCid?)` verifies a wallet SIWE CACAO: size (64 KiB) and nesting (64) limits, the exact-bytes CID, canonical DAG-CBOR, the CACAO shape (integer version 1, no unknown or empty fields, safe-integer chain ID), the ReCap shape and statement, and the EIP-191 signature. It returns the issuer, audience, `expiresAt` and the ReCap attenuation. It does not enforce validity times; callers decide.
  - **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.

## 1.1.1-beta.0

### Patch Changes

- c13720c: `tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.
  - **Error codes for bearer revokes.**
    - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
    - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
    - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
    - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
  - **History.** Revoking an already revoked share keeps its original `revokedAt`.
  - **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
  - **sdk-core.** These are additions only:
    - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
    - The new `parseSignedSiweCacao(authorization, expectedCid?)` verifies a wallet SIWE CACAO: size (64 KiB) and nesting (64) limits, the exact-bytes CID, canonical DAG-CBOR, the CACAO shape (integer version 1, no unknown or empty fields, safe-integer chain ID), the ReCap shape and statement, and the EIP-191 signature. It returns the issuer, audience, `expiresAt` and the ReCap attenuation. It does not enforce validity times; callers decide.
  - **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.

## 1.1.0

### Minor Changes

- 045c2d3: Recipient challenge, delegation, import, and decrypt HTTP rejections now expose a typed response status instead of only embedding it in the message. Notification delivery no longer retries a typed 401/403 refusal and reports `retryable: false` after the first attempt; transient failures retain the existing retry budget.
- b0972e5: `tc share publish --notify` refuses a share without `read` before publication. Domain invitations use `--to domain:<name> --notify --notify-to <mailbox>` on a node reporting 1.17.3 or later; a session-only publisher may deliver its own signed policy when its sender DID matches the policy owner. Unsupported nodes are refused before upload or registration, and standalone `tc share notify` checks stored read permission and domain node support before delivery. Notifications use an atomic, profile-locked sender-history confirmation; a history write failure warns without hiding successful delivery, and concurrent revocation or invitations retain each other's fields. Publish JSON includes the additive `notification` result, including non-retryable window failures. `ShareNotifyError.code` remains `"delivery-failed"`; its optional `reason` distinguishes an expired delivery window. Confirmed repeats report `already-delivered` using encrypted sender history; a lost response remains a retryable failure rather than a false confirmation.

  Post-publication history writes wait through profile-lock recovery, but a failed initial write no longer hides the published link; the CLI warns that sender-history commands cannot later find that share. Share lock timeouts keep the standard `PROFILE_LOCK_TIMEOUT` retry guidance. OpenKey history signing, identity validation, and key derivation occur outside the profile lock, with the selected profile/key rechecked inside it. Standalone domain notifications reject mismatched recipients and expired delivery windows locally before probing the node. A stalled `/info` response body is classified as unavailable rather than an unsupported version, and publish versus notify errors state precisely whether a share was created.

  Each sender-history operation now pins its profile across bounded salt/key-input retries, preventing a changed default profile from receiving another profile's share record. History identity tracks only local private-key material or the OpenKey session signer JWK and verification method, so unrelated profile edits do not interrupt writes. Failed retries and disappearing profiles return a typed, actionable `SHARE_HISTORY_RETRY` instead of an argument error. Writes waiting more than about two seconds for the profile lock name the profile on stderr once, while keeping the 45-second recovery window.

  A profile missing from the outset retains `PROFILE_NOT_FOUND` and its setup guidance instead of masquerading as a retryable history change. The sender-history adapter remembers observed profiles by name across its operations, so a profile removed between a share read and its post-revocation update returns `SHARE_HISTORY_RETRY` with the warning that node revocation may already have succeeded; another previously unseen profile still returns `PROFILE_NOT_FOUND`. Mismatched resolved signer profiles now return the typed history retry error. Node authentication and every sender-history operation share one command-pinned profile, so a changed default cannot send a published share's link to a different profile. The Share reference also lists the exit-1 lock and history-retry codes.

### Patch Changes

- 6de6688: `tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

  `@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.

- Updated dependencies [6de6688]
  - @tinycloud/share-envelope@1.1.0

## 1.1.0-beta.2

### Minor Changes

- 045c2d3: Recipient challenge, delegation, import, and decrypt HTTP rejections now expose a typed response status instead of only embedding it in the message. Notification delivery no longer retries a typed 401/403 refusal and reports `retryable: false` after the first attempt; transient failures retain the existing retry budget.

## 1.1.0-beta.1

### Minor Changes

- b0972e5: `tc share publish --notify` refuses a share without `read` before publication. Domain invitations use `--to domain:<name> --notify --notify-to <mailbox>` on a node reporting 1.17.3 or later; a session-only publisher may deliver its own signed policy when its sender DID matches the policy owner. Unsupported nodes are refused before upload or registration, and standalone `tc share notify` checks stored read permission and domain node support before delivery. Notifications use an atomic, profile-locked sender-history confirmation; a history write failure warns without hiding successful delivery, and concurrent revocation or invitations retain each other's fields. Publish JSON includes the additive `notification` result, including non-retryable window failures. `ShareNotifyError.code` remains `"delivery-failed"`; its optional `reason` distinguishes an expired delivery window. Confirmed repeats report `already-delivered` using encrypted sender history; a lost response remains a retryable failure rather than a false confirmation.

  Post-publication history writes wait through profile-lock recovery, but a failed initial write no longer hides the published link; the CLI warns that sender-history commands cannot later find that share. Share lock timeouts keep the standard `PROFILE_LOCK_TIMEOUT` retry guidance. OpenKey history signing, identity validation, and key derivation occur outside the profile lock, with the selected profile/key rechecked inside it. Standalone domain notifications reject mismatched recipients and expired delivery windows locally before probing the node. A stalled `/info` response body is classified as unavailable rather than an unsupported version, and publish versus notify errors state precisely whether a share was created.

  Each sender-history operation now pins its profile across bounded salt/key-input retries, preventing a changed default profile from receiving another profile's share record. History identity tracks only local private-key material or the OpenKey session signer JWK and verification method, so unrelated profile edits do not interrupt writes. Failed retries and disappearing profiles return a typed, actionable `SHARE_HISTORY_RETRY` instead of an argument error. Writes waiting more than about two seconds for the profile lock name the profile on stderr once, while keeping the 45-second recovery window.

  A profile missing from the outset retains `PROFILE_NOT_FOUND` and its setup guidance instead of masquerading as a retryable history change. The sender-history adapter remembers observed profiles by name across its operations, so a profile removed between a share read and its post-revocation update returns `SHARE_HISTORY_RETRY` with the warning that node revocation may already have succeeded; another previously unseen profile still returns `PROFILE_NOT_FOUND`. Mismatched resolved signer profiles now return the typed history retry error. Node authentication and every sender-history operation share one command-pinned profile, so a changed default cannot send a published share's link to a different profile. The Share reference also lists the exit-1 lock and history-retry codes.

## 1.0.1-beta.0

### Patch Changes

- 6de6688: `tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

  `@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.

- Updated dependencies [6de6688]
  - @tinycloud/share-envelope@1.1.0-beta.0

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

### Minor Changes

- b0069f7: Add first-class accountless share receiving with session-key credential binding, strict PolicyCredentialPresentation/v4 admission, ordinary delegation invocation, and post-render private import into `files-for-you`.
- cc27c3a: Receive email-domain shares. `createEmailDomainCredentialRequirement` builds
  a `{ emailDomain }` requirement for the OpenCredentials
  `tinycloud.email-domain-proof/v1` profile (300-second freshness), and
  `canonicalEmailDomain` / `canonicalMailbox` / `mailboxBelongsToDomain` define
  the single canonical ASCII form (no Unicode or U-labels; `xn--` A-labels
  verbatim) with exact, non-suffix membership. Credential acquisition now keeps
  recipient-entered inputs separate from requirement claims: when a
  requirement does not carry every descriptor input, the inline surface's new
  `requestInputs` collects them (the SDK view asks for a mailbox at the invited
  domain), the SDK checks exact domain membership before creating the request,
  and the issuer derives the signed `emailDomain` itself. `share.receive`
  accepts `emailDomain` matchers bound to the signed policy commitment,
  `ReceivedShare.recipient` gains `{ kind: "emailDomain", domain }`, and the
  completed credential-acquisition progress event reports the verified
  `mailbox`. Claim names may be camelCase. Mailboxes are lowercase RFC 5322
  dot-atoms without `%` or `!` (matching the issuer), inputs that a requirement
  already names must equal it, an issuer `RATE_LIMITED` stop is a recoverable
  `ISSUER_UNREADY` (`state: "rate_limited"`), and `share.receive` allows ten
  minutes for a real mailbox round trip. `publishAddressedShare` refuses
  `emailDomain` shares that grant edit/put, carry a delivery address, or whose
  credential requirement is not exactly `{ emailDomain: domain }`. Exact-email
  behavior and descriptor digests are unchanged.
- 70e6c95: Durable, re-delegatable share access (TC-531) and email delivery for
  email-domain shares (TC-530).
  - **Durable sessions.** Policy admission asks the Node for a session as long
    as the share: `requestedExpiresAt`, which defaults to the policy's expiry
    and can be set to `null` for the legacy minute. On Nodes before 1.17.3,
    which reject the field with 422, it falls back to the 60-second session.
    The request asks for the earlier of the envelope's and the policy's expiry.
    Received sessions longer than 60 seconds are accepted:
    `ShareRecipientClient` bounds them by the share's expiry, and
    `parsePolicySessionUcan` by the 31-day root window.
  - **Re-delegation.** `ReceivedShare.delegate({ to, expiresAt? })`
    re-delegates a received share, decryption included, to another Ed25519
    `did:key`, for example an account session key. It imports the new link into
    the owner's Node and returns the whole chain. The delegate opens the share
    with `share.receive(url, { delegation })` and needs no credential.
    `ShareRecipientClient` verifies every link before use: issuer, the exact
    parent proof, a strictly narrower window, inherited facts with one less
    redelegation, and unchanged capabilities.
  - `signCompactPolicyDescendant` signs a policy descendant with a
    caller-owned, possibly non-extractable, key.
  - **Default to the maximum.** These now default to the longest their parent
    allows, instead of a minute or an hour:
    - policy descendants;
    - `createSubDelegation`;
    - sessions activated from a received delegation.
  - **Domain shares** may grant edit access and may be emailed, like exact-email
    shares. Addressed publishing now refuses unknown policy actions for every
    share kind.

### Patch Changes

- c690844: Reject addressed-share ciphertext whose exact owner-KV bytes do not match the
  signed source digest before key unwrap or rendering. Revoke addressed shares
  through the existing signed Policy/v3 root-revocation path, which cuts off
  active sessions as well as fresh admission and delivery.
- 026bf15: Ship browser-safe compact-UCAN verification and canonical embedded-policy delivery/receive with holder-bound delegation through generic `/delegate` and `/invoke`, without Node `/share/*`.
- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.
- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

- bf6fbd1: Share publication now applies the share viewer's filename policy: names are NFC-normalized, and control, format (such as U+200B zero-width space and U+202E bidi override), surrogate, and U+2028/U+2029 code points are refused before any content is read or uploaded. share-sdk exports `canonicalShareFilename` and `hasUnsafeFilenameCodePoint`, and `publishTargetShare` reports "filename contains control or invisible characters". `tc share publish` refuses every such filename with `UNSAFE_FILENAME` (exit 8), and addressed shares display the NFC-normalized name.
- Updated dependencies [b0069f7]
- Updated dependencies [dc92402]
- Updated dependencies [c690844]
- Updated dependencies [b852650]
- Updated dependencies [026bf15]
- Updated dependencies [2e9db6e]
  - @tinycloud/share-envelope@1.0.0

## 1.0.0-beta.9

### Minor Changes

- 70e6c95: Durable, re-delegatable share access (TC-531) and email delivery for
  email-domain shares (TC-530).
  - **Durable sessions.** Policy admission asks the Node for a session as long
    as the share: `requestedExpiresAt`, which defaults to the policy's expiry
    and can be set to `null` for the legacy minute. On Nodes before 1.17.3,
    which reject the field with 422, it falls back to the 60-second session.
    The request asks for the earlier of the envelope's and the policy's expiry.
    Received sessions longer than 60 seconds are accepted:
    `ShareRecipientClient` bounds them by the share's expiry, and
    `parsePolicySessionUcan` by the 31-day root window.
  - **Re-delegation.** `ReceivedShare.delegate({ to, expiresAt? })`
    re-delegates a received share, decryption included, to another Ed25519
    `did:key`, for example an account session key. It imports the new link into
    the owner's Node and returns the whole chain. The delegate opens the share
    with `share.receive(url, { delegation })` and needs no credential.
    `ShareRecipientClient` verifies every link before use: issuer, the exact
    parent proof, a strictly narrower window, inherited facts with one less
    redelegation, and unchanged capabilities.
  - `signCompactPolicyDescendant` signs a policy descendant with a
    caller-owned, possibly non-extractable, key.
  - **Default to the maximum.** These now default to the longest their parent
    allows, instead of a minute or an hour:
    - policy descendants;
    - `createSubDelegation`;
    - sessions activated from a received delegation.
  - **Domain shares** may grant edit access and may be emailed, like exact-email
    shares. Addressed publishing now refuses unknown policy actions for every
    share kind.

## 1.0.0-beta.8

### Patch Changes

- bf6fbd1: Share publication now applies the share viewer's filename policy: names are NFC-normalized, and control, format (such as U+200B zero-width space and U+202E bidi override), surrogate, and U+2028/U+2029 code points are refused before any content is read or uploaded. share-sdk exports `canonicalShareFilename` and `hasUnsafeFilenameCodePoint`, and `publishTargetShare` reports "filename contains control or invisible characters". `tc share publish` refuses every such filename with `UNSAFE_FILENAME` (exit 8), and addressed shares display the NFC-normalized name.

## 1.0.0-beta.7

### Patch Changes

- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

- Updated dependencies [2e9db6e]
  - @tinycloud/share-envelope@1.0.0-beta.5

## 1.0.0-beta.6

### Patch Changes

- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.

## 1.0.0-beta.5

### Minor Changes

- cc27c3a: Receive email-domain shares. `createEmailDomainCredentialRequirement` builds
  a `{ emailDomain }` requirement for the OpenCredentials
  `tinycloud.email-domain-proof/v1` profile (300-second freshness), and
  `canonicalEmailDomain` / `canonicalMailbox` / `mailboxBelongsToDomain` define
  the single canonical ASCII form (no Unicode or U-labels; `xn--` A-labels
  verbatim) with exact, non-suffix membership. Credential acquisition now keeps
  recipient-entered inputs separate from requirement claims: when a
  requirement does not carry every descriptor input, the inline surface's new
  `requestInputs` collects them (the SDK view asks for a mailbox at the invited
  domain), the SDK checks exact domain membership before creating the request,
  and the issuer derives the signed `emailDomain` itself. `share.receive`
  accepts `emailDomain` matchers bound to the signed policy commitment,
  `ReceivedShare.recipient` gains `{ kind: "emailDomain", domain }`, and the
  completed credential-acquisition progress event reports the verified
  `mailbox`. Claim names may be camelCase. Mailboxes are lowercase RFC 5322
  dot-atoms without `%` or `!` (matching the issuer), inputs that a requirement
  already names must equal it, an issuer `RATE_LIMITED` stop is a recoverable
  `ISSUER_UNREADY` (`state: "rate_limited"`), and `share.receive` allows ten
  minutes for a real mailbox round trip. `publishAddressedShare` refuses
  `emailDomain` shares that grant edit/put, carry a delivery address, or whose
  credential requirement is not exactly `{ emailDomain: domain }`. Exact-email
  behavior and descriptor digests are unchanged.

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

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/share-envelope@1.0.0-beta.4

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
