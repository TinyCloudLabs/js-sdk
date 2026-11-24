---
"@tinycloud/mcp": minor
---

Added opt-in rate limiting to the hosted connector. It is off unless `TC_MCP_RATE_LIMIT=on` (or `HostedMcpConfig.rateLimit` is set), so nothing changes for existing deployments. When on: a per-user budget for each tool class (connect, read, write) and an overall per-user request ceiling; and an aggregate per-OAuth-client cap. A refused tool call is a retryable `RATE_LIMITED` tool error the model can read; other refusals are HTTP 429 with `Retry-After`. State is in memory per process. Tunable with `TC_MCP_RATE_LIMIT_{CONNECT,READ,WRITE,SUBJECT,CLIENT,IP}_PER_MINUTE`.

Per-client-address limits are off unless `TC_MCP_TRUSTED_PROXY_HOPS` is set to the exact number of trusted reverse proxies in front of the server (default `0`: off; the address is that many entries from the right of `X-Forwarded-For`). With them on, an address has a budget on the `/connect` approval route and for bearer tokens on `/mcp`. A presented token is charged before it is checked and refunded if valid, so once an address has spent its budget on rejected tokens, `/mcp` refuses valid tokens from that address too until it refills; users behind one shared egress address share that budget. Behind a TLS pass-through ingress (such as Phala dstack-ingress) the server never sees the client address, so `TC_MCP_TRUSTED_PROXY_HOPS` must stay `0` there.

Details: TC-3145
