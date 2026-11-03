---
"@tinycloud/mcp": patch
"@tinycloud/operations": patch
---

`tinycloud_apps_context` and `tinycloud_apps_query` remain annotated as potentially destructive: context can replace the saved timezone, and a query refresh deletes and reinserts rows in the derived SQL copy. They are not read-only. The query accepts one read-only SELECT and does not change canonical records; context only changes the timezone when one is supplied. Only `tinycloud_apps_write` mutates app records.
Details: TC-2416
