---
"@tinycloud/operations": patch
---

The notice on `tinycloud_sql_execute` no longer says that approving `tinycloud.sql/write` grants "full read/write/schema mutation authority": a write grant lets the agent insert, update and delete any row in the exact database, and cannot run schema statements (CREATE, ALTER, DROP need `tinycloud.sql/schema`). The tool still accepts only one parameterized INSERT, UPDATE or DELETE. The text appears in the tool description, the required acknowledgement field and the result's `authorityNotice`. Details: TC-2454
