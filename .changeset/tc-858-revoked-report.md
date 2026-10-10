---
"@tinycloud/sdk-services": patch
---

Replication status reopens persisted replica state when no handle is active in the current process, so reports retain revoked authority after a grant revocation is discovered and purged by an earlier invocation.
