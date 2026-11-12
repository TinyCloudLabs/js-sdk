---
"@tinycloud/courier": patch
---

`courier watch` now reads its state back after a state write whose outcome is unknown (a timeout, a dropped connection or `outcome_unknown`). If the stored state is unchanged or is its own write, it keeps running; a write by any other process still stops it with `state-conflict`.

Details: TC-2802
