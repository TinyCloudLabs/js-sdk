---
"@tinycloud/courier": patch
---

`courier watch` wake budget, pause and notifications, final behaviour: `--notify` accepts `none`, `osascript` and `exec`. Notifications for new messages and decisions are coalesced into two fixed slots per locally paired peer, with separate retries and counts, and pause notices use fixed per-thread episode slots. Eligible notifications are admitted and dispatched in peer round-robin order within the hourly caps, a retry never delays another peer's reserved share, and a pause or message that arrives while a notice is being delivered keeps its own pending notice. A notice id that is not newer than the stored one, or is more than ten minutes ahead of the local clock, is ignored.

Details: TC-1634
