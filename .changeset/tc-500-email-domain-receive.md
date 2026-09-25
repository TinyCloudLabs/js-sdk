---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/share-sdk": minor
---

Receive email-domain shares. `createEmailDomainCredentialRequirement` builds
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
