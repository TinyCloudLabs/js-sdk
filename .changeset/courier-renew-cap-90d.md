---
"@tinycloud/courier": patch
---

`courier init --renew <duration>` accepts at most 90 days. A longer lease is refused before any approval request is made. The default stays 90 days.

Details: TC-4201
