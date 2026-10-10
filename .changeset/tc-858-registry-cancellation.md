---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Run account-registry SQL, KV, and hosting requests through a dedicated per-operation context so the sign-in deadline cannot abort unrelated requests or persist in cached space-scoped services. Await SQL and DuckDB error-body reads before disposing request cancellation listeners.
