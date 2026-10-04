---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

Classify TinyCloud KV HTTP 401 responses as `AUTH_REQUIRED` and HTTP 403 responses as `PERMISSION_DENIED` in operation and MCP structured results. Both are nonretryable, including empty and misleading response bodies. Keep 5xx node failures retryable and do not expose node response text or transport metadata in canonical results.
