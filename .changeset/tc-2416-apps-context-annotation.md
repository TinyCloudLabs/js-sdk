---
"@tinycloud/mcp": patch
---

`tinycloud_apps_context` is no longer annotated as destructive. It deletes nothing: it lists the owner's apps and saves only their timezone setting when one is supplied, so it is marked not read-only, not destructive and idempotent. `tinycloud_apps_write` and `tinycloud_apps_query` keep their destructive annotation. Details: TC-2416
