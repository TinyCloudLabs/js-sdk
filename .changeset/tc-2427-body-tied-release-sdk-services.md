---
"@tinycloud/sdk-services": patch
---

Release the per-request abort listener when the response body settles, so a long-running service (a poll, a `--wait`, a Courier daemon) keeps flat memory instead of growing a little per request. A request that carries its own abort signal links it to the context's long-lived signal; the listener now stays only while the response body can still be read and is removed when the request fails, or when the body has been read to the end, cancelled or has errored. A response nobody reads releases it when the response is garbage collected, or 60 seconds after the headers if no read has started. Aborting the context (sign-out) still cancels a body being read. The response a request returns is a `Response` built over a pass-through stream with the original status and headers. `linkAbortSignal` and `releaseWithBody` are exported for the node SDK's service graph (not part of the documented API).

Details: TC-2427
