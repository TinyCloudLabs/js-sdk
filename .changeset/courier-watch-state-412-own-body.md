---
"@tinycloud/courier": patch
---

`courier watch` now reads its state back when a state write is refused with a 412. The SDK retries a node 503 with the same if-match, so the refusal can answer the watcher's own write. If the stored state is exactly what it sent, it keeps running; a write by any other process still stops it with `state-conflict`. Each state write now carries a `writer` field (the run's id and a write sequence), so another watcher's state never matches; older CLIs keep the field when they rewrite the state.

Details: TC-2802
