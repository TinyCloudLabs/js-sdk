---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
