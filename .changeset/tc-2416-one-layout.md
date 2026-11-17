---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

New personal apps from the hosted tools go in one layout: the owner's `applications` space, one folder per app (`xyz.tinycloud.tinyapps.<app>/`) with a discovery entry, which is where the `tc-apps` skill puts a new app. Apps already in the older `default`-space folder `xyz.tinycloud.agent-data/` stay there and keep working. `tinycloud_apps_move` (and the `tinycloud.apps.move` operation) is removed.

What breaks for callers: the package no longer exports `isTcAppsPermission`. The `tinycloud_apps_context` and `tinycloud_apps_query` tools are no longer annotated destructive, because neither deletes a saved record.

Same-name apps: if the command-line skill created an older-layout app and a chat app then creates an app with the same name, the skill lists the new app (a discovery entry means the new layout) and not the older records of that name. They are not deleted.

Details: TC-2416
