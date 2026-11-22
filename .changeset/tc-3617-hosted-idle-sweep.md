---
"@tinycloud/mcp": minor
---

The hosted MCP removes an account's stored authority after 30 days with no authenticated call: its delegate key, session, grants and pending approvals. The account's next call creates a new delegate key and asks for the connection approval again. Each authenticated call marks the account at most once an hour, so the mark survives a restart. A sweep runs one minute after start, then every 6 hours, and logs `idle tenant removed` for each account it clears.

Details: TC-3617
