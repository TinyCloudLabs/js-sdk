---
"@tinycloud/mcp": patch
---

The hosted MCP keeps its connections to the TinyCloud node open for up to 62 seconds of idle time, which covers a 60-second status poll. The session check repeats its read once when the node's ingress closes a pooled connection before answering.

Details: TC-3757
