---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

`DelegationManager.revoke` accepts target space and delegation identity context so the node selects an installed principal authorized for that target or fails before signing. The CLI prefers the node's live delegation record and reports when it falls back to local grant history.
