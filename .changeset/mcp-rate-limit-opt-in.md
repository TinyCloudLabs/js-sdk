---
"@tinycloud/mcp": minor
---

Added opt-in rate limiting to the hosted connector. It is off unless `TC_MCP_RATE_LIMIT=on` (or `HostedMcpConfig.rateLimit` is set), so nothing changes for existing deployments. When on: a per-user budget for each tool class (connect, read, write) and an overall per-user request ceiling; an aggregate per-OAuth-client cap; and per-address budgets only on the approval routes and for rejected bearer tokens (the `/mcp` endpoint is never limited by address, because ChatGPT's users share egress addresses). A refused tool call is a retryable `RATE_LIMITED` tool error the model can read; other refusals are HTTP 429 with `Retry-After`. State is in memory per process. Tunable with `TC_MCP_RATE_LIMIT_{CONNECT,READ,WRITE,SUBJECT,CLIENT,IP}_PER_MINUTE` and `TC_MCP_TRUSTED_PROXY_HOPS` (default 1: the address the ingress appended to `X-Forwarded-For`).

Details: TC-3145
