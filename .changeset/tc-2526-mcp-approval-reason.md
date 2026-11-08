---
"@tinycloud/mcp": patch
---

The hosted MCP approval reason no longer ends with "approve only if that is you". It still names the requesting TinyCloud account. The callback already refuses an approval signed by any other account (`approval_owner_mismatch`), so the approver isn't asked to make that check.

Details: TC-2526
