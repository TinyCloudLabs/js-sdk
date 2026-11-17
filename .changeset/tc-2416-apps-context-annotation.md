---
"@tinycloud/mcp": patch
"@tinycloud/operations": patch
---

`tinycloud_apps_context` and `tinycloud_apps_query` are annotated as not destructive but also not read-only. Context can replace the saved timezone, and a query refresh deletes and reinserts rows in the derived SQL copy. The query accepts one read-only SELECT and doesn't change canonical records; context changes the timezone only when one is supplied. Only `tinycloud_apps_write` changes app records, and it is annotated destructive.
Details: TC-2416
