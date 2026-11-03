---
"@tinycloud/mcp": patch
---

When OpenKey's token introspection cannot answer, the hosted MCP now serves a token that OpenKey confirmed active only for 60 seconds after the question OpenKey answered (and until the token expires), counted on a monotonic clock so that a wall-clock step cannot extend it, instead of for the token's whole lifetime. A token revoked during an introspection outage therefore stops working within about 60 seconds, however long the token lives. Tokens OpenKey never confirmed to this server, and tokens answered inactive, are still refused. The 30-second active-answer cache is unchanged.

Details: TC-2395
