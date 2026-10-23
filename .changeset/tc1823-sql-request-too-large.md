---
"@tinycloud/sdk-services": patch
"@tinycloud/operations": patch
---

A 413 from the SQL or DuckDB node is classified by side. A request rejected for size returns `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE`. A response that is too large keeps `SQL_RESPONSE_TOO_LARGE` or `DUCKDB_RESPONSE_TOO_LARGE`.

Details: TC-1823
