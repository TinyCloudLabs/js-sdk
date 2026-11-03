---
"@tinycloud/operations": patch
---

The notice on `tinycloud_sql_execute` no longer says that approving `tinycloud.sql/write` grants "full read/write/schema mutation authority". It now says a write grant lets the agent insert, update and delete any row in the exact database, that nodes enforcing the schema split (the default) also stop it changing the tables, and that nodes which do not enforce it let it. The tool still accepts only one parameterized INSERT, UPDATE or DELETE. The text appears in the tool description, the required acknowledgement field and the result's `authorityNotice`. Details: TC-2454
