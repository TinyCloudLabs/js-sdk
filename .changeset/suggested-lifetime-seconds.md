---
"@tinycloud/share-envelope": patch
---

The signed approval request may carry an optional `suggestedLifetimeSeconds`: a whole number above 0 and no more than `grantLifetimeSeconds`. When it is absent, the maximum applies. The field is optional and additive. No client sends it yet: OpenKey must accept it first. Requests without it parse and canonicalize byte-identically.

Details: TC-2272
