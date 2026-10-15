---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb` accepts an optional `replication` config and forwards it to the node client, and exposes `tcw.replication`. With `replication` unset, the node config is unchanged. `registerReplicationLoaders` is re-exported from the package entry. A restored session with replication enabled and no replica stamp is discarded, and `signIn()` starts a fresh sign-in.
