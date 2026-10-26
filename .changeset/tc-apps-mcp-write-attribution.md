---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

Fix personal-app MCP guidance and generated write schemas for server-owned `by` metadata. Write examples omit `by`, and edit/move instructions tell clients to remove it from read-back values before submitting them. Advertised put/move schemas now reject top-level `by` before invocation, matching the existing runtime restriction. CLI records, nested data fields and stored/read-back attribution remain unchanged.
