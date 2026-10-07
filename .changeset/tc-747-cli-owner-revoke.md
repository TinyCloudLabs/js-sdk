---
"@tinycloud/cli": patch
---

`tc auth grant` saves the exact signed grant separately from runtime permissions. `tc delegation revoke <cid>` tries authority scoped to that CID, falls back to a locally stored signed grant artifact when the host cannot activate root raw-CID authority, and does not persist temporary permissions.
