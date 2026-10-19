---
"@tinycloud/cli": patch
---

Add the node release pin and verified downloader that `tc node install` will use. The CLI embeds SHA-256 pins for the TinyCloud node tarballs and checks the download against them before unpacking. No command uses them yet.
