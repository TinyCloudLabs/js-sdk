---
"@tinycloud/sdk-core": patch
---

`DelegationManager.revokeIssued` reports `NOT_FOUND` only for the node's own `404 Space not found` answer. Any other 404 (a proxy page, an empty body, another route's text) is now a failed request (`NETWORK_ERROR` with `meta.status` 404), so a caller can no longer mistake it for "the delegation is gone". `tinycloud feed disconnect` relies on this: it removes the registry row only for the node's answer, and keeps it on any other failure.

Details: TC-3150
