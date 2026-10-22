---
"@tinycloud/web-sdk": minor
---

The settings panel is now a drawer with a full-page layout and seven sections. Adds `ui.mode` (`"sidebar" | "page" | "both"`, default `"both"`) and the `TinyCloudUI` methods `openPage(section?)`, `toggle()`, `isOpen`, and `available`; `open()` accepts an optional section id.

Breaking for panel consumers: the `sync` section id is renamed to `local-copy`, the `developer` section is removed, and `activity` replaces it behind developer mode. Section bodies other than Local copy and Storage are placeholders.
