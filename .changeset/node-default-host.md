---
"@tinycloud/cli": minor
"@tinycloud/mcp": minor
"@tinycloud/courier": minor
"@tinycloud/operations": patch
---

The CLI, the hosted MCP server and Courier now use `https://node.tinycloud.xyz` as the default TinyCloud node, in place of `https://tee.node.tinycloud.xyz`. Profiles that already store a host keep it. To choose a node: for the CLI, pass `--host <url>`, set `TC_HOST` or create a profile with `tinycloud profile create <name> --host <url>`; for the MCP server, set `TC_HOST`; for Courier, pass `--host <url>` or set `COURIER_HOST`.

Details: TC-2923
