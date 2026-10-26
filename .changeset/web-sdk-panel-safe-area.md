---
"@tinycloud/web-sdk": patch
---

The panel keeps its header, close control and content inside the device safe areas (iOS notch, status bar, home indicator, landscape side insets). The header stays at the top inside the safe area while the content scrolls, and a downward swipe of at least 60 px on the header closes the panel on touch devices. `tc.ui.setButtonVisible(visible: boolean)` shows or hides the floating button at runtime: `true` shows it even under `ui.button: false` and clears the stored hidden flag, `false` hides it without writing that flag.

Details: TC-2130
