---
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
---

Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so `ServiceContext.fetch` now retries them under the existing `retryPolicy`: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.
