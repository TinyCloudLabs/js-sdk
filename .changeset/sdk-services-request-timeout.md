---
"@tinycloud/sdk-services": patch
---

Apply the configured request timeout. `SQLService`, `KVService`, and `DuckDbService` documented a `timeout` config (and KV a per-call `timeout` option) but never used it, so a request whose response never arrived hung forever. A request now aborts once its timeout elapses, including while the response body is still being read, and the operation returns an `ErrorCodes.TIMEOUT` error with `meta.timeoutMs`. Caller and sign-out aborts still return `ErrorCodes.ABORTED`. A per-call KV `timeout` overrides the service config, and `0` disables it. There is still no default timeout: services without one configured behave as before. These services also remove, when a request finishes, the abort listeners they add to the service and context signals, which were previously left behind.
