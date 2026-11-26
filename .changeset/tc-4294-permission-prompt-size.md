---
"@tinycloud/web-sdk": patch
---

Opening the permission prompt loads about 50 KB, because the prompt uses the copy of the SDK the page has loaded.

Details: TC-4294
