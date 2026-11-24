---
"@tinycloud/mcp": minor
---

The hosted MCP asks OpenKey for approval with a signed approval request and collects the approved delegation from OpenKey's result API. Opening a `/connect` link creates the request, signed by the tenant's own key, and redirects to its OpenKey link. The server collects the result in the background (every 2 seconds for the first minute, then every 10 seconds) and before each call from that account, stores it once and acknowledges it. A refused approval leaves the same link usable for a new attempt; the refusal is logged as `approval result rejected:` with its stage and code. Results are fetched only from the configured OpenKey API origin, `TC_OPENKEY_API_HOST` (default `https://api.openkey.so` for `https://openkey.so`). `TC_LINKS_API_ORIGIN` sets the links service that holds the request. The `/connect/callback` routes are removed. When OpenKey cannot create the request, the link answers `503` with a page asking the person to try again in a minute.

Details: TC-3617
