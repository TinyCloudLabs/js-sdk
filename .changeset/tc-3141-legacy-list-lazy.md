---
"@tinycloud/operations": patch
---

A new hosted connection on an account with apps in the original `default/xyz.tinycloud.agent-data/` layout now finds those apps before it makes a same-named one. When `tinycloud_apps_context` names an app that is not in the new layout, or `tinycloud_apps_write` creates an app, the connection asks for a separate, read-only approval to read the original app list (OpenKey approves one space at a time). Once approved, an older app with that name is used and a duplicate create is refused. Listing apps, and reading or changing apps already in the new layout, ask for nothing extra. If the owner declines, only the call that needed the list stops, and it shows the same approval request when retried. Connections that already read the original list are unchanged.

Details: TC-3141
