---
"@tinycloud/mcp": patch
---

The hosted MCP now stores an approved operation delegation only when the wallet that signed it is the OpenKey account whose MCP request created the approval link, the same check `tinycloud_connect` already applied. A delegation signed by any other account is refused before anything is written, and `/connect/callback` answers `403` with code `approval_owner_mismatch` and a fixed message. The OpenKey approval page now shows which TinyCloud account requested the approval.
