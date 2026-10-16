---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb` accepts an optional `replication` config and exposes `tcw.replication`. Apps enabling it import the pure `@tinycloud/web-sdk/replica` plugin, call root `registerBrowserReplica(browserReplicaPlugin)` before constructing the client, and await `loadIndexedDbReplicaStorage()` before supplying browser storage. Missing or duplicate registration throws immediately; importing the optional entry alone does not register it. With replication unset, the root import does not load replica storage or start a worker. Missing, stale or malformed replica stamps gate local reads without discarding an otherwise valid network session; only a fresh interactive finite-expiration owner sign-in can establish a new stamp. Network restore never repairs it.
