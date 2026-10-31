---
"@tinycloud/share-envelope": patch
---

The OpenKey approval request schema (`requestVersion` 1) accepts an optional `suggestedLifetimeSeconds`: an integer of at least 1 that is at most `grantLifetimeSeconds` (absent means the maximum; the field has no upper bound of its own, and the request stays strict). `OpenKeyApprovalRequestV1` gains the optional field. A request without the field parses and canonicalizes to exactly the same bytes as before. Only the schema and the type change: nothing sends the field yet.

Details: TC-2272
