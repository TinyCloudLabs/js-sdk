---
"@tinycloud/node-sdk": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. The node's service graph left one abort listener on its lifetime signal for every request that carried its own signal, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The request's signal is now combined with the graph's through `AbortSignal.any` where it exists, and through a listener that is removed when the request settles where it does not. Retiring the graph still aborts in-flight requests and the response body being read. One difference: an abort now reaches the request with the abort reason of the signal that fired (for example a `TimeoutError`) instead of a bare `AbortError`.

Details: TC-2418
