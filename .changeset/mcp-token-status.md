---
"@tinycloud/mcp": patch
---

The hosted MCP server checks each access token's status with OpenKey's resource-server token introspection endpoint before serving a call. Only a 200 answer with `active: true` is active, and only when its `sub` and `client_id` equal the verified token's and its `aud` is a non-empty subset of the token's audiences that includes the server's resource URL; an active answer is reused for 30 seconds. An inactive token is answered with 401 `invalid_token`, and that answer is kept for the token. When OpenKey cannot be reached or answers otherwise, a call is served only when OpenKey itself answered that same token active to this server, and only until the time since OpenKey's last answer for it reaches the token's lifetime; every other call is answered with 500 `server_error`. A 401 from the endpoint is logged once and refused. The server needs `TC_MCP_INTROSPECTION_URL`, `TC_MCP_INTROSPECTION_CLIENT_ID` and `TC_MCP_INTROSPECTION_CLIENT_SECRET` (and optionally `TC_MCP_INTROSPECTION_AUTH_METHOD=basic|post`) and does not start without them. The README lists where an owner manages the hosted MCP's delegation.

Details: TC-1627
