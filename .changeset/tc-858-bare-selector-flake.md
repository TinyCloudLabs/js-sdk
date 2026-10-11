---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
---

Bound the sign-in account-registry drain to four seconds and abort its SQL, KV, and hosting requests on expiry. Registry failures remain warning-only, so sign-in succeeds after the bounded drain.
