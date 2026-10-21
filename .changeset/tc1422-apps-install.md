---
"@tinycloud/cli": minor
---

New `tinycloud apps install <app_id>` installs a pinned catalog app (currently `xyz.tinycloud.sample.healthlog`) into your applications space. It fetches each file from Share by its pinned bundle digest and checks its sha256 and size before anything is written. Only after every byte verifies does it run the pinned `schema.sql` (allowed: `CREATE TABLE/INDEX/VIEW IF NOT EXISTS` and `DROP VIEW IF EXISTS` for the pinned views; any other statement, including `DROP TABLE`, aborts before running). It then writes the knowledge files to KV create-only under `<app_id>/knowledge/`, with `index.md` last. Existing keys with different bytes are reported as `conflict` and never overwritten, and the command exits non-zero. Re-running is safe: it reports `already` when every file matches. TC-1422
