---
"@tinycloud/sdk-services": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. A request that carries its own abort signal used to leave a listener on the context's long-lived signal until the context aborted, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The listener is now removed when the request settles, whether it succeeds, fails, times out or is aborted. Aborting the context still aborts in-flight requests, and a request's own timeout or signal still aborts only that request.

Details: TC-2418
