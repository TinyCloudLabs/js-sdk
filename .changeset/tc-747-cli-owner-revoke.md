---
"@tinycloud/cli": patch
---

`tc auth grant` saves the exact signed grant separately from runtime permissions. `tc delegation revoke <cid>` resolves revocation authority for the exact CID, falls back only to a locally stored signed grant artifact, and does not persist temporary permissions.
