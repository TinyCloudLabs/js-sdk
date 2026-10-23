---
"@tinycloud/sdk-services": patch
"@tinycloud/operations": patch
---

SQL and DuckDB requests rejected for size now return `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE`, with a message asking the caller to split the batch. Responses that are too large keep `SQL_RESPONSE_TOO_LARGE` and `DUCKDB_RESPONSE_TOO_LARGE`. Fast-copy and SQL operations map the request-side error to `INPUT_INVALID`.

Details: TC-1823
