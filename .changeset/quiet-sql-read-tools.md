---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
"@tinycloud/sdk-services": minor
---

Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.
