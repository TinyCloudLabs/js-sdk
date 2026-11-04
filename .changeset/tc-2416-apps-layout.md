---
"@tinycloud/operations": minor
---

The personal-apps operations follow the `tc-apps` skill 0.3.10 layout, so records saved through the hosted connector land where the CLI skill puts them. A new app is kept in the owner's `applications` space under `xyz.tinycloud.tinyapps.<app>/` (catalog at `<app>/catalog`, kinds at `<app>/catalog/<kind>`, records at `<app>/<kind>/<folder>/<id>`) with a discovery entry at `xyz.tinycloud.tinyapps.catalog/<app>/entry`, written after the app's first kind. Apps already in the older `default` space under `xyz.tinycloud.agent-data/` stay there, readable and writable as before, until a later move (the layout is chosen per app, as the skill's `layout.sh` does). A new app is refused when the older layout already holds it, and a legacy key is refused when its app has moved and the entry is readable. The names `catalog`, `index-stale`, `healthlog` and `recipes` are reserved for new apps.

Older-layout access to an app also needs the app list (a read of its entry), so a moved app is always recognised, and its older records are no longer served. A discovery entry for an app the older layout still holds is added only by a move (a later change), never by a plain write; a folder that holds another app's `manifest.json` cannot become a generic app, every change to a record in a new-layout app needs the app's catalog record, and a record is not created before the app's discovery entry when the app list is readable.

Approvals are now per app: `xyz.tinycloud.tinyapps.<app>/` (get, list, put, del), the app list `xyz.tinycloud.tinyapps.catalog/` (get, list, put), and a read-only look at the older catalog `xyz.tinycloud.agent-data/catalog/` (get, list) when an app is created or the app list is read. The fast copy is one SQL database per app, `xyz.tinycloud.tinyapps.<app>/index`.

What breaks for callers: `tinycloud.apps.query` requires a `layout` (`new` or `legacy`) and one app per call, and the new-layout `entries` view has no `app` column; `tinycloud.apps.context` returns `apps` (app, layout, title, copy) and no longer returns a top-level `copy`; a move now stays inside one app; `tinycloud.apps.read` and `tinycloud.apps.write` accept keys of either layout. The package exports `TC_APPS_LEGACY_ROOT` and `TC_APPS_LEGACY_DATABASE` in place of `TC_APPS_ROOT` and `TC_APPS_DATABASE`.
Details: TC-2416
