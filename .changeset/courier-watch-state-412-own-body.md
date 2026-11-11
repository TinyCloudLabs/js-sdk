---
"@tinycloud/courier": patch
---

`courier watch` now reads its state back when a state write is refused with a 412. The SDK retries a node 503 with the same if-match, so the refusal can answer the watcher's own write. If the stored state is exactly what it sent, it keeps running; a write by any other process still stops it with `state-conflict`.

Details: TC-2802
