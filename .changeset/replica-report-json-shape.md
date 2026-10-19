---
"@tinycloud/cli": patch
---

Breaking change to `tc replica report --json` (beta feature, from #551 / TC-841): the report is now read-only and never starts a replication runtime, so `replicas` is always `[]` and `replicasUnavailable` is always `true`. Per-partition pinned counts moved from `replicas[].pinned` to `partitions[].pinned` (each partition has `idHash`, `host`, `space`, `pinned`). Scripts reading `.replicas[].pinned` should read `.partitions[].pinned` instead. Live replica status returns with TC-1309.
