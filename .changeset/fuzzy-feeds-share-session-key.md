---
"@tinycloud/node-sdk": patch
---

Keep TinyCloudNode session-key accessors synchronized with the active key and make repeated sign-in rotate that key safely, so delegation flows do not reference the removed default key.
