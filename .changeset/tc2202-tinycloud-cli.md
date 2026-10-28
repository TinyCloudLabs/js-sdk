---
"@tinycloud/cli": minor
---

Rename the core agent skill to `tinycloud-cli` and stop installing the conflicting `tc` executable alias. Scripts that invoked the old `tc` command must use `tinycloud`.

Details: TC-2202
