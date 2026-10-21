---
"@tinycloud/mcp": minor
"@tinycloud/operations": patch
---

Add the separate `/chatgpt/mcp` public personal-record endpoint with exactly connect, context, read, write and query tools. Public OAuth audiences, tenant state, approvals and recovery suggestions are isolated from the existing broad `/mcp` service; excluded tools cannot be invoked by name. Preserve local/private integrations and return an inert browser recovery page for invalid approval links.

Correct context/query mutation annotations and operation effects, ask for an IANA timezone rather than location, and preserve bounded derived-query output without truncating canonical write outcomes. Add reproducible MCP-only plugin packaging and explicit reviewer/publication gates.

Deploy the matching OpenKey API audience and exact web callback registrations before candidate acceptance. The package is not a published plugin: actual ChatGPT web/mobile tests, independent reviewer access, approved policies, recording and portal review remain required. Default-branch integration and deployment require explicit owner approval.
