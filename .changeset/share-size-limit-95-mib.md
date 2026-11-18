---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

The share size limit is now 95 MiB (99,614,720 bytes), the most the TinyCloud node accepts in one upload. A larger file used to pass the CLI's 100 MiB check and then fail at the node with a 413. It now stops before uploading with "Shared files must be under 95 MB. Use a smaller file or split it." `--max-bytes` accepts 1 byte to 95 MiB.

Details: TC-3252
