---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

Keep `tinycloud_apps_context` inside the hosted 100,000-character result limit for owners with large `default/xyz.tinycloud.agent-data/` catalogs. Past a 60,000-character budget the context inlines only the app catalogs and leaves kind catalogs listed in `catalog.keys` for `tinycloud_apps_read`; every existing app is still listed with its title.

Details: TC-2416
