---
"@tinycloud/node-sdk": patch
---

Release the service graph's per-request abort listener when the response body settles, so a long-running process keeps flat memory instead of growing a little per request. The listener stays on the graph's lifetime signal only while the response body can still be read, so retiring the graph (sign-out) still cancels a body being read, and is removed when the request fails or the body has been read, cancelled or has errored. A response nobody reads releases it when the response is garbage collected, or 60 seconds after the headers if no read has started.

Details: TC-2427
