---
"@tinycloud/share-envelope": patch
"@tinycloud/share-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/cli": patch
---

Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.

- `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
- The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
- The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
- `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
- A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
- `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.
