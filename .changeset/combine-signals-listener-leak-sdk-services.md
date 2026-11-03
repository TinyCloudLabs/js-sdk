---
"@tinycloud/sdk-services": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. A request that carries its own abort signal used to leave a listener on the context's long-lived signal until the context aborted, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The listener is now removed when the request fails, or when its response body has been read, cancelled or has errored. It stays until then, so aborting the context (sign-out) still cancels a body being read. A response nobody reads releases it when the response is garbage collected, or after 60 seconds if no read has started. The response a request returns is now a new `Response` over a pass-through stream: status, status text, headers and every body reader behave as before, but `url`, `redirected` and `type` are not carried over. The two helpers behind this are exported for `@tinycloud/node-sdk` and are not part of the documented API.

Details: TC-2418
