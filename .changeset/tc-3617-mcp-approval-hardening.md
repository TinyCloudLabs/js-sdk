---
"@tinycloud/mcp": patch
---

The hosted MCP's approval links need the account that requested them: a link without one is no longer created, and a stored link without one stores nothing, so the first wallet to approve can no longer become the owner. One account's links hold at most four of the 64 background approval polls, so one account cannot starve the others'. The server refuses to start when the OpenKey API origin (`TC_OPENKEY_API_HOST`) is not `https`.

Details: TC-3617
