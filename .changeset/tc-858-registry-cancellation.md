---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Keep account-registry KV requests inside the sign-in deadline without retaining an expired signal in reusable scoped services. Await SQL and DuckDB error-body reads before disposing request cancellation listeners.
