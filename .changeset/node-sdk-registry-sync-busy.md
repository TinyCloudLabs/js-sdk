---
"@tinycloud/node-sdk": patch
---

The account registry sync no longer retries a node's `NODE_BUSY` or `REQUEST_TIMEOUT` answer itself. The SDK has already retried it, under its retry policy and the node's `Retry-After`, so the sync's own three tries multiplied the requests a busy node got: a registry write cost it up to 12 requests and now costs at most 4. The sync stops with a warning (as it does for an authorization verdict or a full storage space) and the next sync tries again. Other failures keep the three tries.

Details: TC-3243
