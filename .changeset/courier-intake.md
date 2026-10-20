---
"@tinycloud/courier": minor
---

Add `courier intake`: reads the mirror of each paired peer's messages from your self-space KV and writes one JSON record per message into a queue directory for a local reader, with cheap text checks and flags. Peers default to 100 inbound messages per hour; `peers.json` can lower that per peer. An invalid `peers.json` entry refuses the whole file: startup stops, and a running reader keeps its last good map. Queue text is capped at 16 KiB. Messages over the per-peer cap are kept in an overflow directory for 7 days, capped at 200 files and 1 MiB per peer, oldest first. Each cycle examines up to 200 mirror rows. To skip existing history, run `courier intake --init-from-now` before the first run.
