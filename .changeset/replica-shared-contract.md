---
"@tinycloud/sdk-services": patch
"@tinycloud/cli": patch
---

Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds two subpaths, `@tinycloud/sdk-services/kv/replication/contractConstants` and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`.
