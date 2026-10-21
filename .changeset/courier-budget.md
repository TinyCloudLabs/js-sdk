---
"@tinycloud/courier": minor
---

Wake budget, pause and notifications for `courier watch`: at most `--wake-budget` (default 12) message wakes per side per thread per UTC day, then the thread pauses: a marker under `me/state/paused/`, an `inform` "thread paused" to the peer (never wakes it), and a notification to your human through `--notify paseo|osascript|exec` (queued in state and retried). A paused thread still delivers and mirrors but never wakes; the peer's watcher notifies its human when it sees the inform. New `courier pause <peer> <thread>` and `courier resume <peer> <thread>` (the budget starts over). Approval wakes are never counted or blocked.

Count wake attempts (including failures), cap and deduplicate fixed-text notices with bounded persisted retries, and retain a bounded backlog through pause/resume. Notifications use local logs, osascript or an operator exec command only; no notification starts or messages an agent.
