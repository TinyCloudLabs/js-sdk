---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

Classify KV and SQL HTTP authorization refusals in operation and MCP structured results. A plain 401 is nonretryable `AUTH_REQUIRED`; 403 or a 401 naming a validated missing capability is nonretryable `PERMISSION_DENIED`, so an agent does not retry signing in when a capability grant is needed. Keep 5xx node failures retryable except uncertain SQL writes, and never expose node response text or transport metadata in canonical results.
