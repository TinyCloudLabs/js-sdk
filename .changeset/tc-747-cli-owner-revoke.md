---
"@tinycloud/cli": patch
---

`tc auth grant` records the issued delegation CID and target capabilities locally. `tc delegation revoke <cid>` resolves the target space from grant history (or delegation metadata), then acquires `tinycloud.delegation/revoke` for that exact space when needed. The ability is requested only for the explicit revoke operation; default owner login permissions remain unchanged.
