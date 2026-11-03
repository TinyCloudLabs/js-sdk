---
"@tinycloud/mcp": minor
---

The MCP HTTP endpoint (hosted and self-hosted) now answers calls and CORS preflights from any browser Origin instead of an allowlist. Every call is still authorized only by the OAuth access token in the `Authorization: Bearer` header: a call without a valid token gets 401 with `WWW-Authenticate`, whatever its Origin. Responses carry `Access-Control-Allow-Origin: *` and `Vary: Origin`, never `Access-Control-Allow-Credentials`, and expose only `WWW-Authenticate`; a preflight allows a fixed list of the headers MCP clients send. The `allowedOrigins` config option and the `TC_MCP_ALLOWED_ORIGINS` environment variable are removed: a set `TC_MCP_ALLOWED_ORIGINS` is now ignored, and `allowedOrigins` is removed from the `createHostedMcpApp` config type, so TypeScript callers that set it get a compile error (JavaScript callers' value is ignored). The native-service path still refuses any request that carries an Origin.

Details: TC-2394
