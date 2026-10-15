---
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
"@tinycloud/replica": patch
---

Replication: validate `maxBytes` and `minFreeBytes` in node-sdk config; read `TC_REPLICATION_GRANT_TTL_MS` and `TC_REPLICATION_MAX_BYTES` in the CLI; show pending content purge in `tinycloud replica report`; persist grant policy in the replica SQLite store (schema v2, idempotent migration) and refuse reads past its bound.
