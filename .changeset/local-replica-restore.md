---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
---

Restore persisted sessions from local state and initialize replication on demand. Explicit network KV reads bypass replica setup. Refresh browser hosting and panel grants after restore.

Details: TC-2773
