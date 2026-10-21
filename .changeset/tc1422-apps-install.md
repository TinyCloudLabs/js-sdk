---
"@tinycloud/cli": minor
---

New `tinycloud apps install <app_id>` installs a pinned catalog app (currently `xyz.tinycloud.sample.healthlog`) into the applications space of the profile it runs under (the owner's space, for a delegate profile, through the grant). It fetches each file from Share by its pinned bundle digest and checks its size and sha256 before anything is written. It then checks the pinned DDL: only `CREATE TABLE/INDEX/VIEW IF NOT EXISTS` and `DROP VIEW IF EXISTS` for the pinned views are allowed, and any other statement, including `DROP TABLE`, aborts before any write. It reads every knowledge file under `<app_id>/knowledge/` first, then creates the missing ones create-only, with `index.md` last. Then it applies the schema and re-creates the pinned views on every run.

If `<app_id>/app/install.json` names a different bundle digest than this CLI pins, or is not a valid install record, the command refuses with `INSTALL_RECORD_MISMATCH` or `INSTALL_RECORD_INVALID` before writing anything. A missing record is not an error.

Existing knowledge files whose bytes differ from the pinned version are left as you edited them and reported; they are not overwritten. The command exits 0 in that case, and the remaining files are still installed. JSON output lists them under `conflicts`.

If the schema fails after notes were written, the command says "notes saved; tables not set up: run again" and exits non-zero. Re-running is safe: it reports `already` when nothing needed writing.

Node-version note: the schema-scope grant is the same on every node. Nodes before 1.21.6 do not enforce the schema/data split for `ddl_requires_schema`. On those nodes the allowlist covers only the installer's own statements; the grant itself does not limit the agent's SQL to data statements.

Details: TC-1422
