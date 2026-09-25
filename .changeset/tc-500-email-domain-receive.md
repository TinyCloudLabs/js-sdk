---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
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
`mailbox`. Claim names may be camelCase. Exact-email behavior and descriptor
digests are unchanged.
