---
"@tinycloud/mcp": patch
---

The hosted MCP endpoint now answers calls and CORS preflights from any browser Origin instead of an `TC_MCP_ALLOWED_ORIGINS` allowlist. Every call is still authorized only by the OAuth access token in the `Authorization: Bearer` header: a call without a valid token gets 401 with `WWW-Authenticate`, whatever its Origin. Responses carry `Access-Control-Allow-Origin: *`, never `Access-Control-Allow-Credentials`, and expose only `WWW-Authenticate`. The `allowedOrigins` config option and the `TC_MCP_ALLOWED_ORIGINS` variable are removed (a set value is now ignored). The native-service path still refuses any Origin.

Details: TC-2394
