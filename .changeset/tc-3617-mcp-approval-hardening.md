---
"@tinycloud/mcp": patch
---

The hosted MCP creates an approval link only with the account that requested it, and a stored link without one stores nothing, so only one of that link's accounts can approve it. One account's links hold at most four of the 64 background approval polls, so other accounts' links keep being polled. The server refuses to start when the OpenKey API origin (`TC_OPENKEY_API_HOST`) isn't `https`.

Details: TC-3617
