---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

Fixed: a fresh hosted connection on an account that already holds `xyz.tinycloud.agent-data/` records no longer sees none of them, and no longer creates a same-named app beside them. After a connection's own approval, the next `tinycloud_apps_context` (or an app-creating `tinycloud_apps_write`) asks for a second, separate approval to read the original app list in the default space (OpenKey signs one space per approval, so it cannot ride along with the first). Once granted, legacy apps are listed and a create over an existing legacy app is refused. Connections that already read the original list, and legacy-only connections, are unchanged.

Details: TC-3141
