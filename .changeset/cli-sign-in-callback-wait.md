---
"@tinycloud/cli": patch
---

`tinycloud auth login` keeps its browser callback open for the full five-minute sign-in window, so the browser can finish a slow local-network permission prompt. Interactive sign-in also prints a one-time how-to line on stderr after 15 seconds while it waits. JSON output is unchanged.

Details: TC-1675
