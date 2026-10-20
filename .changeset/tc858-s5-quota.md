---
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
---

Replication: enforce `maxBytes` on node/CLI replica storage. A page is admitted inside the guarded commit, before any write; when the profile's stored content plus the page's new blob bytes would exceed the budget, the page is refused with `STORAGE_BUDGET` and nothing is committed. Admission charges a page its net bytes (replaced or deleted content is credited) against the content actually on disk, and orphaned blobs are collected inside the same hold so on-disk content stays within the budget. `maxBytes` bounds the committed replica content (blob bytes); during a page commit the previous blobs of replaced entries remain until the commit completes, so on-disk bytes can transiently reach cap + bytes replaced by the page; the database file, WAL, rows and the pending store are not counted. Orphaned blobs left by a crash are collected on open, under the profile guard. Without `maxBytes`, storage behaves as before.
