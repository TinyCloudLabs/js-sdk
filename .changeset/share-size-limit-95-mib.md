---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

Shares can be up to 95 MiB, the most the TinyCloud node accepts in one upload (99,614,720 bytes). A larger file stops before uploading with "Shared files can be up to 95 MiB. Use a smaller file or split it." When several files together pass the limit, the message reads "These files add up to more than 95 MiB. Share fewer at once or use smaller files." `--max-bytes` accepts 1 byte to 95 MiB, and a file over a smaller `--max-bytes` gets its own message naming that limit.

Details: TC-3252
