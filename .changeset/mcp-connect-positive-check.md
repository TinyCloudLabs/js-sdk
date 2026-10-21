---
"@tinycloud/mcp": patch
---

`tinycloud_connect` reports `connected: true` only after the node confirms the account session. When the node cannot confirm it (timeout, unreachable, or an unexpected response), the tool reports `connected: false` with no approval URL instead of a connected state.

Details: TC-1627
