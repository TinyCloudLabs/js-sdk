---
"@tinycloud/cli": patch
---

`tc share receive` opens a bearer link again when the account that shared it has no published storage settings: it reads the file from the default node, `https://node.tinycloud.xyz`. It still refuses when the registry can't be reached.

Details: TC-3181
