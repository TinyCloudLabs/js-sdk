---
"@tinycloud/web-sdk": patch
---

Revoking a grant now asks the node to revoke it when its status cannot be read, instead of reporting it as already ended.

Details: TC-2031
