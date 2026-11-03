---
"@tinycloud/operations": minor
---

The hosted personal-records rules route meals, food, calories, body weight and recipes to the first-party Health Log and Recipes tiny apps instead of the generic store (the pinned `tc-apps` skill's routing table, now vendored as `TINY-APPS.md`), so a meal saved through the connector lands where the CLI skill puts it. The model reads the app's notes with `tinycloud_knowledge_read`, then logs with one parameterized `tinycloud_sql_execute` on `xyz.tinycloud.sample.healthlog/healthlog` (`meal` and `weight` tables, `op_id` for idempotence, `day_card` read-back). It never installs the app or changes its tables: when the notes are missing it tells the owner to open the Health Log tiny-app link once. These tools are not on the public ChatGPT plugin surface, so there the rules say meals and recipes cannot be saved from that connector yet. `tinycloud.apps.context` returns `utc` (the same instant as `now`) for `logged_at`. Details: TC-2416
