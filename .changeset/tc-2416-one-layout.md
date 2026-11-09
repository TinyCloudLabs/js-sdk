---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

The hosted personal-records tools use one layout: the owner's `applications` space, one folder per app (`xyz.tinycloud.tinyapps.<app>/`) with a discovery entry, as the `tc-apps` skill puts a new app. They no longer read or write the older `default`-space folder `xyz.tinycloud.agent-data/`, and `tinycloud_apps_move` (and the `tinycloud.apps.move` operation) is removed. Records already saved in the older folder stay where they are, untouched, and are not shown by the chat tools. A new app now needs one OpenKey request (two for the first new app without the `app` input of `tinycloud_apps_context`), because there is no read-only look at the older app list any more.

What breaks for callers: `tinycloud.apps.query` has no `layout` input; `tinycloud.apps.context` returns `apps` (app, title, copy) and no longer returns `legacy`, `catalog` or each app's `layout`; keys under `xyz.tinycloud.agent-data/` are refused as invalid personal-record keys; the package no longer exports `TC_APPS_LEGACY_ROOT` or `TC_APPS_LEGACY_DATABASE`. The `tinycloud_apps_context` and `tinycloud_apps_query` tools are no longer annotated destructive (neither deletes a record).

Same-name apps: if the command-line skill created an older-layout app and a chat app then creates an app with the same name, the skill lists the new app (a discovery entry means the new layout) and not the older records of that name. They are not deleted.

Details: TC-2416
