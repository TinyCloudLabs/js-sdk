---
"@tinycloud/node-sdk": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. The node's service graph left one abort listener on its lifetime signal for every request that carried its own signal, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The listener is now removed when the request settles. Retiring the graph still aborts in-flight requests, and a request's own signal still aborts only that request.

Details: TC-2418
