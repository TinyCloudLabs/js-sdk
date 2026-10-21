---
"@tinycloud/courier": minor
---

Wake budget, pause and notifications for `courier watch`: at most `--wake-budget` (default 12) message wakes per side per thread per UTC day, then the thread pauses: a marker under `me/state/paused/`, an `inform` "thread paused" to the peer (never wakes it), and a notification to your human through `--notify none|osascript|exec` (queued in state; at most three notification attempts, every success/failure counts toward the 10/hour/peer and global caps). A paused thread still delivers and mirrors but never wakes; the peer's watcher notifies its human when it sees the inform. New `courier pause <peer> <thread>` and `courier resume <peer> <thread>` (the budget starts over). Approval wakes are never counted or blocked.

Count wake attempts (including failures), cap and deduplicate fixed-text notices with bounded persisted retries, and retain a bounded backlog through pause/resume. Notifications use local logs, osascript or an operator exec command only; no notification starts or messages an agent.

Track pause/resume transitions in fixed records for locally known threads, ignore notice ULIDs that are not newer than the stored one or are more than ten minutes ahead of the local clock, keep inform ids stable through retries, and persist separate message/approval backoff from attempt completion. Keep two fixed pending episode slots per known thread, with separate retries and a bounded count for additional pauses. Reserve up to three of the global hourly attempts per locally paired peer.

In notify-only mode, coalesce messages and decisions into two fixed slots per locally paired peer, with separate retries, counts and latest thread ULIDs. Admit and dispatch eligible notifications in peer round-robin order while retaining deferred retry metadata and arrivals during dispatch.
