---
"@tinycloud/cli": patch
"@tinycloud/mcp": patch
"@tinycloud/courier": patch
"@tinycloud/operations": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/server": patch
"@tinycloud/vfs": patch
---

The node SDK, sdk-core, the server package and the VFS provider use `https://tee.node.tinycloud.xyz` when no host is set, the same default as the CLI, the hosted MCP server and Courier. Profiles and configs that already name a host keep it.

Details: TC-2923
