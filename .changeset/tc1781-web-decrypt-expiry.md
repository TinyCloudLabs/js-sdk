---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb.requestPermissions` passes `expiryMs` through for decrypt grants, including wildcards, like any other entry.

Details: TC-1781
