---
"@tinycloud/cli": patch
---

Replication: read `TC_REPLICATION_GRANT_TTL_MS` and `TC_REPLICATION_MAX_BYTES` in the CLI; both must be plain decimal integers (grant TTL at most 7 days), otherwise the command fails with a usage error naming the variable.
