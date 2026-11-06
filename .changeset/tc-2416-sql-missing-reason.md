---
"@tinycloud/operations": patch
---

Keep the known `sql_database_missing` reason in canonical error details so agents can distinguish an uninstalled app from retryable node failures. Unknown node details remain redacted.

Details: TC-2416
