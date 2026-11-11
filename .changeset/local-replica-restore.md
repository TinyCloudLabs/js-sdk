---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
---

Restore persisted sessions from local state and initialize replication on demand. Explicit network KV reads bypass replica setup. Refresh browser hosting and panel grants after restore.

Serialize panel-grant storage updates and sign-out cleanup so a delayed reactivation cannot overwrite a newly granted permission.

Details: TC-2773
