---
"@tinycloud/cli": patch
---

`tc share receive` opens a bearer link from an account that has published no storage settings, reading the file from the default node, `https://node.tinycloud.xyz`. It refuses when the registry can't be reached.

Details: TC-3181
