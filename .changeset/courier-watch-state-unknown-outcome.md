---
"@tinycloud/courier": patch
---

`courier watch` now reads its state back after a state write whose outcome is unknown (a timeout, a dropped connection or `outcome_unknown`). If the stored state is unchanged or is its own write, it keeps running. A write by any other process is still a `state-conflict`: the watcher stands by (`--once` exits).

Details: TC-2802
