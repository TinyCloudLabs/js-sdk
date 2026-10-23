---
"@tinycloud/web-sdk": minor
---

The settings panel is now a drawer with a full-page layout and seven sections. Adds `ui.mode` (`"sidebar" | "page" | "both"`, default `"both"`) and the `TinyCloudUI` methods `openPage(section?)`, `toggle()`, `isOpen`, and `available`; `open()` accepts an optional section id.

Breaking for panel consumers: the `sync` section id is renamed to `local-copy`, the `developer` section is removed, and `activity` replaces it behind developer mode. Section bodies other than Local copy and Storage are placeholders.

On phones (`(max-width: 600px), (pointer: coarse)`) the panel always opens as a full page with a Close button and no sidebar control; the bottom sheet is removed. Phones get a Sections menu button in place of the section pills. The sidebar and full-page layouts share one switch button, labelled with the layout it moves to ("Full page" or "Sidebar"), replacing the two former toggle labels.
