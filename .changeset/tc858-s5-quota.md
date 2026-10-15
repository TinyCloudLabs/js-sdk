---
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

Replication: enforce `maxBytes` on node/CLI replica storage. A page is admitted inside the guarded commit, before any write; when the profile's stored content plus the page's new blob bytes would exceed the budget, the page is refused with `STORAGE_BUDGET` and nothing is committed. Adds the `STORAGE_BUDGET` error code. Without `maxBytes`, storage behaves as before.
