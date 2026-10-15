---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb` accepts an optional `replication` config and exposes `tcw.replication`. Apps enabling it must call `registerReplicationLoaders` (re-exported from the web SDK) with the runtime, authority and platform gate loaders before constructing the client; missing registration throws immediately. With replication unset, the node config is unchanged. Missing, stale or malformed replica stamps gate local replica use without discarding an otherwise valid network session; only a fresh interactive sign-in establishes a new stamp.
