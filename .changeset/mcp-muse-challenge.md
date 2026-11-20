---
"@tinycloud/mcp": patch
---

The hosted HTTP server can answer Meta's Muse domain verification. Set `TC_MCP_MUSE_CHALLENGE` to the token (or the whole `muse-challenge=<token>` line) and `GET /.well-known/muse-challenge/<token>` returns 200 `text/plain; charset=utf-8` with `muse-challenge=<token>`, without sign-in. Any other token, or no variable, gets the usual 404. The MCP addresses and their tools are unchanged.

Details: TC-2416
