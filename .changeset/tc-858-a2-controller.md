---
"@tinycloud/sdk-services": minor
---

Add the `KVReplication` policy controller and identity-scoped memory pending store, including per-replica catch-up fences, pending-write outcome handling, local get/list parity, and replication events.
Stale-read timeouts now refresh replica status before offline admission and distinguish timeout-owned cancellation from aborts of a shared sync by its caller, close, or purge.
