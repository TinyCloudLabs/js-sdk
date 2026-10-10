---
"@tinycloud/sdk-services": minor
---

Add the `KVReplication` policy controller and identity-scoped memory pending store, including per-replica catch-up fences, pending-write outcome handling, local get/list parity, and replication events.
Stale-read timeouts now refresh replica status before offline admission and distinguish timeout-owned cancellation from aborts of a shared sync by its caller, close, or purge.
Local GET and every local LIST probe now require complete coverage and valid authority from read-time metadata; a refusal falls back to network or restarts a `tcr1` continuation.
The post-drain status refresh is bounded and caller-cancellable; status failures refuse offline admission.
