---
"@tinycloud/node-sdk": patch
---

Stop leaking an abort listener per request: long waits no longer print `MaxListenersExceededWarning` on Node 20. The node's service graph left one abort listener on its lifetime signal for every request that carried its own signal, so a loop of more than 10 requests (a poll, a `--wait`) made Node 20 warn `11 abort listeners added to [AbortSignal]` on stderr and held every listener until sign-out. The request's signal is now combined with the graph's through `AbortSignal.any` where it exists (Node 20.3 and later, current browsers), which adds no listener to the graph's signal. Retiring the graph still cancels in-flight requests and a response body being read. On Node the combined signals stay reachable while the graph lives (about 65 B per request on Node 20 and 180 B on Node 22, against about 1 KB per request before). One difference: an abort now reaches the request with the abort reason of the signal that fired (for example a `TimeoutError`) instead of a bare `AbortError`. Runtimes without `AbortSignal.any` behave as before.

Details: TC-2418
