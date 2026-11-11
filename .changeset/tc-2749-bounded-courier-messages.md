---
"@tinycloud/courier": minor
---

Read exact messages with `read <thread> --peer <peer> --message <id>` (repeat up to 20 ids), without downloading the thread archive. Each side reports found, missing or incomplete outcomes; message reads use a 64 KiB per-value limit and a shared 10-second data-read deadline. Receipt-update warnings no longer print SDK error payloads.

Details: TC-2749
