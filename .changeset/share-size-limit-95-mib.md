---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

The share size limit now matches what the TinyCloud node accepts in one upload (99,614,720 bytes, 95 MiB). A file for anyone with the link can be up to 95 MiB; a file shared with specific people is encrypted first and grows by a third, so it can be up to 71 MiB. A larger file used to pass the CLI's 100 MiB check and then fail at the node with a 413. It now stops before uploading with "Shared files must be under 95 MB. Use a smaller file or split it." or "Files shared with specific people must be under 71 MB. Use a smaller file or split it." `--max-bytes` accepts 1 byte to 95 MiB, and a file over a smaller `--max-bytes` gets its own message naming that limit.

Details: TC-3252
