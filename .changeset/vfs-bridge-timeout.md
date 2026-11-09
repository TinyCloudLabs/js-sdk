---
"@tinycloud/vfs": patch
---

VFS worker bridge calls now stop waiting after a bounded time and throw a typed `TinyCloudVfsBridgeTimeoutError` (code `ETIMEDOUT`).

Details: TC-2608
