---
"@tinycloud/courier": patch
---

`courier watch` lists every peer in full every 5 minutes while its hook subscriptions are healthy, instead of every minute. Hook events still deliver at once; a failed or ended subscription catches up at once and brings back the full listing every `--poll` seconds until a new stream is healthy; a peer whose sync did not finish is listed again at the next minute. A catch-up lists the pause markers once for all peers, and a peer's renewal marker is read on the renewal schedule, on a marker hook event, or before a refusal is final, not on every sync. The renewal and authority check still runs every `--poll` seconds, and again before anything is imported from a peer whose last check is older than that.

Details: TC-2917
