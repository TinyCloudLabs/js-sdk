---
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
---

Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.
