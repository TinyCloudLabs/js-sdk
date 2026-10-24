---
"@tinycloud/web-sdk": minor
---

The settings panel is now a drawer with a full-page layout and seven sections. Adds `ui.mode` (`"sidebar" | "page" | "both"`, default `"both"`) and the `TinyCloudUI` methods `openPage(section?)`, `toggle()`, `isOpen`, and `available`; `open()` accepts an optional section id.

Breaking for panel consumers: the `sync` section id is renamed to `local-copy`, the `developer` section is removed, and `activity` replaces it behind developer mode. Section bodies other than Overview, Local copy and Storage are placeholders.

On phones (`(max-width: 600px), (pointer: coarse)`) the panel always opens as a full page with a Close button and no sidebar control; the bottom sheet is removed. Phones get a Sections menu button in place of the section pills. The sidebar and full-page layouts share one switch button, labelled with the action it performs: "Open full page" in the sidebar and "Show as sidebar" on the full page. This replaces the two former toggle labels, so consumers or tests that matched "Full page" or "Sidebar" by text must match the new labels.

Once the panel has loaded, toasts render in a region inside the panel layer with a status icon and a 44 px Dismiss button, and sections can show receipt slips (dashed rows of identifiers with a Copy receipt action). Toasts that appear before the panel loads, such as storage full and sync notices, keep the launcher styling.

Toast auto-dismiss default changes from 5000 ms to 7000 ms when a toast is pushed without `durationMs`. Consumers that relied on the 5 s default should pass `durationMs` explicitly.
