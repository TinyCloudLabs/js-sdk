---
"@tinycloud/mcp": patch
---

The hosted MCP's signed connection request is now signed as standing access and asks for up to 30 days (`TC_MCP_BOOTSTRAP_DELEGATION_EXPIRY`, default `30d`) with an optional renewal lease of up to 90 days; OpenKey shows the renewal box ticked for it, since it reaches no secrets or decryption, and the owner chooses the actual lifetime and whether to keep the lease. A scoped task request asks for `TC_MCP_DELEGATION_EXPIRY` (default `1h`) with no purpose and no renewal. Before, both kinds shared `TC_MCP_DELEGATION_EXPIRY`, so the production `30d` setting also gave scoped tasks 30 days. Production `docker-compose.phala.yml` now sets `TC_MCP_DELEGATION_EXPIRY=1h` and `TC_MCP_BOOTSTRAP_DELEGATION_EXPIRY=30d`. A pending approval opened under a longer scoped lifetime, or with an older connection ask (no standing purpose, or another lease), is no longer served or reused, and a longer scoped one is never collected. Idle retirement and the required account match are unchanged.

Details: TC-3617
