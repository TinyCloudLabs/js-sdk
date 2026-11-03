---
"@tinycloud/mcp": minor
---

The hosted personal-records tools keep new apps in the owner's `applications` space under `xyz.tinycloud.tinyapps.<app>/`, with a discovery entry, so records saved through the connector match the CLI skill's (`tc-apps` 0.3.10). Apps already in the `default` space under `xyz.tinycloud.agent-data/` stay there until moved. The approval screens change: first use asks for the app list (`xyz.tinycloud.tinyapps.catalog/`); a new app asks for its own folder (`xyz.tinycloud.tinyapps.<app>/`), then for a read-only look at the older catalog (`xyz.tinycloud.agent-data/catalog/`) unless an older grant covers it, because OpenKey signs one space per delegation; later apps ask for their own folder only. The fast copy is one database per app, `xyz.tinycloud.tinyapps.<app>/index`. `tinycloud_apps_query` now needs a `layout` and one app per call; `tinycloud_apps_context` returns `apps` and `legacy`. Details: TC-2416
