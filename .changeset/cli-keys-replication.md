---
"@tinycloud/cli": patch
---

`tc auth login --method openkey --keys <folder>` works together with replication prefixes: one OpenKey approval covers the replica request and the folder's key row.

Details: TC-2034
