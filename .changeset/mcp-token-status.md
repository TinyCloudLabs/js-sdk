---
"@tinycloud/mcp": patch
---

The hosted MCP server checks each access token's status with OpenKey's token introspection endpoint before serving a call. An inactive token is answered with 401 `invalid_token`, and that answer is kept for the token. When OpenKey cannot be reached, calls are served for less than the token's lifetime after its last answer, then answered with 500 `server_error`. The server needs `TC_MCP_INTROSPECTION_CLIENT_ID` and `TC_MCP_INTROSPECTION_CLIENT_SECRET` (and optionally `TC_MCP_INTROSPECTION_AUTH_METHOD=basic|post`) and does not start without them.

Details: TC-1627
