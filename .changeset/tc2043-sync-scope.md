---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Replication accepts `syncScope: "prefixes"`, which keeps kv/sync on the declared prefixes at sign-in instead of widening to a root entry that covers them.

Details: TC-2043
