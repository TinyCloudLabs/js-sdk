---
"@tinycloud/cli": patch
---

`tc auth grant` records the issued delegation CID and target capabilities locally. `tc delegation revoke <cid>` prefers the node's live delegation record, falls back to local grant history only when needed, and reports which source supplied the target space. It then acquires `tinycloud.delegation/revoke` for that exact space when needed; default owner login permissions remain unchanged.
