---
"@tinycloud/mcp": minor
---

The hosted HTTP server publishes more agent discovery. `/.well-known/api-catalog` is an RFC 9727 linkset for `/mcp` (server card, documentation, `/healthz`), and the landing page links it with `rel="api-catalog"`. `/.well-known/agent-skills/index.json` lists the shipped `tinycloud-delegated-secrets` skill, served at `/.well-known/agent-skills/tinycloud-delegated-secrets/SKILL.md` with its SHA-256 digest; the skill now starts with `name` and `description` frontmatter. `/.well-known/agent-card.json` redirects to TinyCloud's A2A discovery agent card on tinycloud.xyz, because this server does not speak A2A. The landing page loads `/webmcp.js`, which registers one read-only WebMCP tool, `get_tinycloud_mcp_connection`, returning the endpoint, OAuth discovery, documentation and local stdio alternative the page shows; its CSP now allows same-origin scripts. `robots.txt` declares the same Content Signals as tinycloud.xyz.

Details: TC-3336
