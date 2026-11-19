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

Default node is `https://tee.node.tinycloud.xyz`. The CLI, the hosted MCP server, Courier, the node SDK and the VFS provider use it when no host is set. Profiles that already store a host keep it.

Details: TC-2923
