---
"@tinycloud/sdk-services": minor
---

SQL and DuckDB report the node's `507 sql_database_size_limit` as `DATABASE_SIZE_LIMIT` (new code, `meta.retryable: false`) instead of `NETWORK_ERROR`. It means the database is at the node's size limit for one database and nothing was changed; repeating the request fails the same way until the database is smaller. A write that would grow the database past the limit carries `DATABASE_SIZE_LIMIT_MESSAGE`; a database already too large to open carries `DATABASE_TOO_LARGE_TO_OPEN_MESSAGE`. Other 507s (such as `duckdb_disk_headroom`) are unchanged. `isStorageFullError` is unchanged: this limit is per database, not the owner's storage plan.

Details: TC-3354
