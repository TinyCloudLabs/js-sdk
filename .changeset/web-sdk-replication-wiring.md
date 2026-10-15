---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb` accepts an optional `replication` config and forwards it to the node client, and exposes `tcw.replication`. With `replication` unset, the node config is unchanged. `registerReplicationLoaders` is re-exported from the package entry. Missing, stale or malformed replica stamps gate local replica use without discarding an otherwise valid network session; only a fresh interactive sign-in establishes a new stamp.
