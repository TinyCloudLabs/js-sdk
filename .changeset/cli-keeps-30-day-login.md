---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

A login, grant or decrypt grant made through the CLI, `@tinycloud/operations` or the MCP server without an expiry still lasts 30 days. The SDK's default for the same requests is 7 days.

Details: TC-3443
