---
"@tinycloud/sdk-services": patch
"@tinycloud/cli": patch
---

Report the node's retry signals (tinycloud-node #347) as typed errors instead of `NETWORK_ERROR`, for SQL, DuckDB and KV get, head, list, put and delete.

- `NODE_BUSY`: `503 sql_busy:<stage>` or `unavailable_retryable`. Nothing was applied. `meta.stage` (`lock_wait`, `hydration`, `artifact_transfer` or `identity_resolution`) when the node names one.
- `REQUEST_TIMEOUT`: `503 request_timeout`. The node's deadline passed before any write began, so nothing was applied.
- `OUTCOME_UNKNOWN`: `500 outcome_unknown`. A write may have been applied; read it back before retrying a non-idempotent operation.

`meta.retryable` says whether a retry is safe and `meta.retryAfterMs` carries the node's `Retry-After`. The SDK still never retries by itself. A response without these bodies, such as a 503 or 500 from node 1.20.6, keeps its old code, and real transport failures stay `NETWORK_ERROR`. New export: `nodeRetryError`.

Fix: a conditional KV `put` or `delete` that got a 503 was reported as `KV_CONFLICT`. A 503 is never a conflict; the node's precondition failure is its 412, still `KV_PRECONDITION_FAILED`. The SDK no longer produces `KV_CONFLICT` itself (callers that handle it keep working). A conditional write's 503 is now `NODE_BUSY` or `REQUEST_TIMEOUT` with the typed body, otherwise `KV_WRITE_FAILED` (put) or `NETWORK_ERROR` (delete) with `meta.status` 503.

`tc` prints a plain message for the new codes ("The node is busy, try again in 5 s.", "Outcome unknown: the node may have applied the write. Check before retrying.") and exits 7.
