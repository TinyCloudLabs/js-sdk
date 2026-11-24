---
"@tinycloud/cli": patch
---

`tc auth login --renew <duration>` accepts at most 90 days. A longer lease is refused before any sign-in starts. The default stays 30 days.

Details: TC-4201
