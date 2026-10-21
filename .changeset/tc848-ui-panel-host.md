---
"@tinycloud/web-sdk": minor
---

Add a floating button and panel to `TinyCloudWeb`, with a `tc.ui` API (`open`, `close`, `toggle`, `isOpen`, `available`) and a `ui` config option. The button is shown by default; pages that do not want it set `ui: { button: false }`, and `ui: false` disables the UI entirely. The panel is not rendered inside iframes or opaque origins.
