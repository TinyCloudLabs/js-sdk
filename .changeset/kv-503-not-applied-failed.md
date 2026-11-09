---
"@tinycloud/sdk-services": patch
---

A pending KV write whose request got the node's 503 busy/`unavailable_retryable` answer, which says nothing was applied, now settles as failed instead of ambiguous. A 5xx without that marker, and `request_timeout`, stay ambiguous.

Details: TC-2606
