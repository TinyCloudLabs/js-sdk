---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Mint the ability the node actually dispatches for SQL/DuckDB
`execute`/`export`/`describe` (TC-114).

`SQLService.executeStatementOnDb`/`exportDb` and
`DuckDbService.executeStatementOnDb`/`describeDb` were sending the literal method
name as the invocation ability (`tinycloud.sql/execute`,
`tinycloud.sql/export`, `tinycloud.duckdb/execute`, `tinycloud.duckdb/describe`).
The node has no such capabilities — it routes these requests by request-body
kind gated by read/write/admin — so under chain containment a narrowly-delegated
session (read+write, no `sql/*`/`duckdb/*` wildcard) 401s on these calls. They
worked previously only because real grants carry the service wildcard.

Each method now mints the dispatchable ability grounded in the node's routing:
`export`/`describe` are authorized as reads (`tinycloud.{sql,duckdb}/read`) and
named-statement execution as a write (`tinycloud.{sql,duckdb}/write`, which the
SQL parser accepts for both read-only and mutating statements). Public method
signatures and the exported `SQLAction`/`DuckDbAction` request-kind constants are
unchanged. Narrowly-delegated sessions with no service wildcard now get working
`export`, `executeStatement`, and `describe`.
