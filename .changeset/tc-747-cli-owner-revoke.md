---
"@tinycloud/cli": patch
---

`tc auth grant` records the issued delegation CID and target capabilities locally. `tc delegation revoke <cid>` prefers the node's live delegation record, acquires narrowly scoped delegation-list authority when needed to resolve its principals, and falls back to local grant history only when the node cannot provide the target. It acquires `tinycloud.delegation/revoke` for the exact target space when needed; default owner login permissions remain unchanged.
