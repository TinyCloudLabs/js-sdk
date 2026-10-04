---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
---

TC-649: For a missing secret, the setup link printed by `tc secrets get` and returned by MCP `secrets.get` now opens Secret Manager with the name filled in: `https://secrets.tinycloud.xyz/app?secret=NAME` plus `&scope=…` when scoped. Before, `https://secrets.tinycloud.xyz?name=NAME` opened the landing page and filled in nothing.
