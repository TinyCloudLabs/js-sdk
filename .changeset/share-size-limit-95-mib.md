---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

The share size limit now matches what the TinyCloud node accepts in one upload (99,614,720 bytes). Files shared with anyone who has the link can be up to 95 MiB. Files shared with specific people can be up to 71 MiB, because encryption makes a file about a third bigger. A larger file used to pass the CLI's 100 MiB check and then fail at the node with a 413. It now stops before uploading with "Shared files can be up to 95 MiB. Use a smaller file or split it." or "Files shared with specific people can be up to 71 MiB. Use a smaller file or split it." When several files together pass the limit, the message reads "These files add up to more than 95 MiB. Share fewer at once or use smaller files." `--max-bytes` accepts 1 byte to 95 MiB, and a file over a smaller `--max-bytes` gets its own message naming that limit.

Details: TC-3252
