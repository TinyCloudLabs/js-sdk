---
"@tinycloud/cli": minor
---

TC-634: `tc kv` previously surfaced some HTTP 401/403 refusals as `AUTH_UNAUTHORIZED` or `NETWORK_ERROR` with exit 1. Get, put, head, list, and delete now return `AUTH_REQUIRED` (exit 3) for plain 401 and `PERMISSION_DENIED` (exit 5) for 403 or a 401 with a validated missing capability. `tc space list|host` and `tc sql` honor typed status, while deliberately constructed CLI errors retain their own code, exit code, and metadata. Capability-request hints use validated TinyCloud resources and actions; noninteractive JSON adds optional `meta` with HTTP status and only validated resource/action fields, never arbitrary server metadata. Non-auth failures and `tc share` redaction remain unchanged.
