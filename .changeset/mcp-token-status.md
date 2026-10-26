---
"@tinycloud/mcp": patch
---

The hosted MCP server checks each access token's status with OpenKey's resource-server token introspection endpoint before serving a call. Only a 200 answer with `active: true` whose `sub`, `client_id` and `aud` match the verified token is active, and an active answer is reused for 30 seconds. An inactive token is answered with 401 `invalid_token`, and that answer is kept for the token. When OpenKey cannot be reached, calls are served for less than the token's lifetime after its last answer, then answered with 500 `server_error`; a 401 from the endpoint is logged once and refused. The server needs `TC_MCP_INTROSPECTION_URL`, `TC_MCP_INTROSPECTION_CLIENT_ID` and `TC_MCP_INTROSPECTION_CLIENT_SECRET` (and optionally `TC_MCP_INTROSPECTION_AUTH_METHOD=basic|post`) and does not start without them. The README lists where an owner manages the hosted MCP's delegation.

Details: TC-1627
