---
"@tinycloud/web-sdk": patch
---

Reuse confirmed browser registry routing verdicts for 60 seconds across session operations. Browser routing observes changes to registry locations within 60 seconds instead of refreshing on every operation.

Details: TC-2987
