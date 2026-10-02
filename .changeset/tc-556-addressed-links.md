---
"@tinycloud/share-sdk": patch
"@tinycloud/cli": patch
---

Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing. `publishAddressedShare` now refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts. The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
