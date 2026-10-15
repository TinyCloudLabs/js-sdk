---
"@tinycloud/cli": patch
---

Purge replicas before clearing the session on `auth logout`. A replica that is still syncing keeps the session.
