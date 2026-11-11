---
"@tinycloud/courier": patch
---

`courier watch` no longer stops with `state-conflict` after one of its own state writes is applied but its reply is lost (a timeout, a dropped connection, `outcome_unknown`). Before its next write it reads `me/state/watch.json` back: its own body or no change carries on; a write by any other process still stops it.

Details: TC-2802
