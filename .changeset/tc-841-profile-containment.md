---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
---

`tc replica reset --purge` refuses symlinked replica roots and entries, including entries replaced while the command is running. Profile writes and purge operations refuse symlinked profile directories.
