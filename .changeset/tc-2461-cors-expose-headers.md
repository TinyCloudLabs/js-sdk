---
"@tinycloud/mcp": patch
---

The hosted MCP endpoint now lets browser clients read the `Mcp-Session-Id` and `Mcp-Protocol-Version` response headers, as well as `WWW-Authenticate` (`Access-Control-Expose-Headers`). Before, only `WWW-Authenticate` was exposed, so a browser MCP client could not read either header even though a preflight already allows them in requests. Today's stateless server does not set them on responses, so current clients see no change. Details: TC-2461
