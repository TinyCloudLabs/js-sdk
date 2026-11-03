---
"@tinycloud/sdk-services": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. A request that carries its own abort signal used to leave a listener on the context's long-lived signal until the context aborted, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The request's signal is now combined with the context's through `AbortSignal.any` where it exists, and through a listener that is removed when the request settles where it does not. Aborting the context still aborts in-flight requests and the response body being read, and a request's own timeout or signal still aborts only that request.

Details: TC-2418
