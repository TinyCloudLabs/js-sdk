---
"@tinycloud/server": minor
---

Delegated-secret KV read failures now retain the structured service error as their cause. Consumers can distinguish HTTP 401/403 authorization failures from other failures without parsing response text; the diagnostic message remains available.
