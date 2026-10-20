---
"@tinycloud/courier": minor
---

Add `courier intake`: reads the mirror of each paired peer's messages from your self-space KV and writes one JSON record per message into a queue directory for a local reader, with cheap text checks and flags. Peers default to 100 inbound messages per hour; `peers.json` can lower that per peer. Queue text is capped at 16 KiB. The first run queues the existing mirror backlog.
