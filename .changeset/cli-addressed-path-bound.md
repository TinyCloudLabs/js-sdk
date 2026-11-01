---
"@tinycloud/cli": patch
---

The addressed share producer (DID, email and email-domain targets) encrypts under the share's own named key `share/<shareId>` and registers the raw-byte wrapped-key digest, through the share-sdk helpers. Which addressed targets the CLI offers is unchanged.

Details: TC-2242
