---
"@tinycloud/mcp": patch
"@tinycloud/operations": patch
---

`tinycloud_apps_context` and `tinycloud_apps_query` are no longer annotated as destructive, so clients stop treating every call as a deletion. Neither deletes records. Context lists the owner's apps and saves only their timezone setting when one is supplied. A query refreshes the app's derived searchable copy (rewriting its rows and clearing its own stale marker) before running one read-only SELECT, and never changes records; the tool description now says so. Both stay not read-only, and `tinycloud.apps.query` no longer declares the `destructive` effect. Only `tinycloud_apps_write` keeps the destructive annotation. Details: TC-2416
