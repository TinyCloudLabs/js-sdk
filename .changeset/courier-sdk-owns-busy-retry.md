---
"@tinycloud/courier": patch
"@tinycloud/sdk-services": patch
---

A busy node is retried once, by the SDK, not twice. Courier's own read retry (three tries on any 5xx or network error) no longer retries a node's `NODE_BUSY` or `REQUEST_TIMEOUT` answer: the SDK has already retried it under its retry policy and the node's `Retry-After`, so a read of a persistently busy node cost it up to 12 requests and now costs at most 4. Courier still retries network errors and other 5xx answers.

`KVService.batchGet` now reports a 503 busy or timeout answer as `NODE_BUSY` or `REQUEST_TIMEOUT` (with `meta.status` 503 and `meta.retryable`), as `get`, `put`, `list` and `delete` already did; it was a `NETWORK_ERROR`, which hid from callers that the SDK had retried it. A 503 that is not the node's busy answer is still a `NETWORK_ERROR`.

Details: TC-3243
