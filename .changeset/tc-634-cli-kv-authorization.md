---
"@tinycloud/cli": minor
---

TC-634: `tc kv` now maps HTTP 401 to `AUTH_REQUIRED` (exit 3) and HTTP 403 to `PERMISSION_DENIED` (exit 5) for get, put, head, list, and delete. It retains structured service metadata so capability hints work; noninteractive error JSON gains a `meta` field containing only validated authorization status, resource, and required action, never arbitrary server metadata. `tc space list` and `tc space host` also respect typed authorization status instead of misleading response wording. Other errors keep their existing mappings, and `tc share` remains redacted.
