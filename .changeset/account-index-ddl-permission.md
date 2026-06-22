---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
