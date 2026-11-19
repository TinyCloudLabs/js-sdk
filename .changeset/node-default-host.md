---
"@tinycloud/cli": minor
"@tinycloud/mcp": minor
"@tinycloud/courier": minor
"@tinycloud/operations": patch
---

The CLI, the hosted MCP server and Courier now use `https://node.tinycloud.xyz` as the default TinyCloud node, in place of `https://tee.node.tinycloud.xyz`. Profiles that already store a host keep it. To keep using `https://tee.node.tinycloud.xyz`, set `--host` or `TC_HOST` for the CLI and the MCP server, or `COURIER_HOST` for Courier.

Details: TC-2923
