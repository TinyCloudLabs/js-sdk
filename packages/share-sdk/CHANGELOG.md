# @tinycloud/share-sdk

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
