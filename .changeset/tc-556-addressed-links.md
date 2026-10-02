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
- `normalizeShareTarget` canonicalizes exact-email targets to the issuer's lowercase mailbox (`Foo@X.com` becomes `foo@x.com`), so the matcher, commitment and display agree with the credential issuer. It refuses mailboxes and domains the receiver would reject, such as a numeric top-level label.
- `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.
- A location registry failure during `tc share publish` now reports `UNAVAILABLE` (exit 4) with a retry hint.
