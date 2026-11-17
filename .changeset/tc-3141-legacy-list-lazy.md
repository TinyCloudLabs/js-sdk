---
"@tinycloud/operations": patch
---

New hosted connections now find apps saved in the original `default/xyz.tinycloud.agent-data/` layout before making one with the same name. When `tinycloud_apps_context` names one of your own apps that isn't in the new layout, or `tinycloud_apps_write` creates an app, the connection asks the owner for a separate, read-only approval to read the original app list (OpenKey approves one space at a time). Once approved, the older app with that name is used and a duplicate is refused. Listing apps, published apps such as `healthlog`, and apps already in the new layout need no extra approval. If the owner declines, only the call that needed the list stops; retrying it shows the same request. Connections that already read the original list are unchanged.

Details: TC-3141
