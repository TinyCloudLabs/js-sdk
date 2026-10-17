---
"@tinycloud/replica": patch
---

Share a verified writable SQLite handle across concurrent controllers for the same replica directory until the last controller closes. A changed database inode is refused while a controller remains open; independent processes continue to open the replica normally.
