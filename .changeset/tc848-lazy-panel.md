---
"@tinycloud/web-sdk": minor
---

The settings panel is now loaded on demand. It is fetched on first open or when the launcher is hovered or focused, which takes it out of the eager bundle. Measured on the release build with `gzip -9 -n -c < <file> | wc -c`: the eager entry (`harness-entry.js`) is 10560 B and the lazy panel chunk (`dist/panel.mjs`) is 10464 B, both under the 12 KiB (12288 B) budget.

Behavior change for panel consumers: the panel mounts after an asynchronous import. Code that queries the shadow root synchronously right after `open()` will not find the panel yet. Poll or wait for it to mount before querying it.
