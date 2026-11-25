---
"@tinycloud/web-sdk": patch
---

The permission prompt shows the description an app sets on each requested permission as the first line of that permission, in small muted text above the built-in text and the technical details. The description is shown as plain text on one line and cut to 140 characters; a longer one ends with "…" and is shown whole in the technical details. A permission without a description shows only the built-in text and the technical details.

The prompt shows invisible operators (U+2060 to U+2064) and tag characters (U+E0000 to U+E007F) as visible escapes such as `\u{E0041}`, as it does for other hidden characters, and the app's caption drops them.

Details: TC-4323
