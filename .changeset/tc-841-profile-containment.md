---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
---

`tc replica reset --purge` pins the selected replica root across open and deletion and refuses symlinked or replaced entries. Profile reads, writes and purge operations refuse symlinked profile directories.
