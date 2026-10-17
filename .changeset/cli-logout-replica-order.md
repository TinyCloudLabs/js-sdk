---
"@tinycloud/cli": patch
---

`auth logout` removes local replicas before clearing the session, and a plain logout always clears the session. If a replica is still syncing or cannot be removed, the error reports that the session was cleared and which replicas remain.
