---
"@tinycloud/operations": minor
---

The hosted personal-records rules route meals, food, calories, body weight and recipes to the first-party Health Log and Recipes tiny apps instead of the generic store (the pinned `tc-apps` skill's routing table, now vendored as `TINY-APPS.md`), so a meal saved through the connector lands where the CLI skill puts it. The model logs with fixed, parameterized statements on `xyz.tinycloud.sample.healthlog/healthlog` through `tinycloud_sql_query` and `tinycloud_sql_execute` (`meal` and `weight` tables, `op_id` for idempotence, `day_card` read-back) and reads none of the app's notes, which keeps a first meal at five approvals instead of nine. The first query doubles as the install check: it never installs the app or changes its tables, and when the database or table is missing it tells the owner to open the Health Log tiny-app link once. Recipes are read-only for now (no vetted statements to save one). These tools are not on the public ChatGPT plugin surface, so there the rules say meals and recipes cannot be saved from that connector yet.

`tinycloud_sql_query` (and the schema inspector) now report a database or table that does not exist as `NODE_ERROR` with `error.details.reason: "sql_database_missing"` and `retryable: false`, instead of a retryable `NODE_ERROR`, and a `404 Space not found` as `NODE_ERROR` with `details.reason: "space_not_hosted"`; permission, quota, network and other SQL errors are unchanged. `tinycloud.apps.context` returns `utc` (the same instant as `now`) for `logged_at`.

Details: TC-2416
