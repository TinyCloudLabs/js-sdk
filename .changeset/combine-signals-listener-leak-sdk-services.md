---
"@tinycloud/sdk-services": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. A request that carries its own abort signal used to leave a listener on the context's long-lived signal until the context aborted, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The request's signal is now combined with the context's through `AbortSignal.any` where it exists (Node 20.3 and later, current browsers), which adds no listener to the long-lived signal. The combined signal lives for the whole request, so aborting the context still cancels in-flight requests and a response body being read, and a request's own timeout or signal still aborts only that request. On Node the combined signals stay reachable while the context lives (about 65 B per request on Node 20 and 180 B on Node 22, against about 1 KB per request before). Runtimes without `AbortSignal.any` behave as before.

Details: TC-2418
