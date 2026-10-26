---
"@tinycloud/share-envelope": patch
---

`prepareLinkRecord` and `createLink` set the link header `expiresAt` to whole seconds, truncated toward the past, so it never runs later than the caller's `expiresAt`.

Details: TC-1737
