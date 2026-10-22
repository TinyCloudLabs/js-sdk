---
"@tinycloud/web-sdk": minor
---

The settings panel is now loaded on demand. It is fetched on first open or when the launcher is hovered or focused, which takes it out of the eager bundle. The eager entry gzips to 10236 B and stays under its 12 KiB budget.

Behavior change for panel consumers: the panel mounts after an asynchronous import. Code that queries the shadow root synchronously right after `open()` will not find the panel yet. Poll or wait for it to mount before querying it.
