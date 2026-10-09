---
"@tinycloud/node-sdk": minor
---

Add the Phase 1 replication B-node surface for the TC-858 read-through flag: `sqliteReplicaStorage` (Node entry only), the per-prefix `ReplicationAuthority`, `planDelegation`/`replicationAuthority`, `replicationSignInEntries()`, and sign-in augmentation.

- `replication` config (enabled, prefixes, storage, allowSecrets) is validated at construction: storage is required, prefixes must be non-empty and non-overlapping, and `vault/` prefixes require `allowSecrets`.
- Sign-in requests gain one `{tinycloud.kv, space, prefix, [get, sync]}` entry per configured prefix already covered by an unrestricted `get`; `replicationSignInEntries()` returns the same augmentation the SIWE recap carries for the restore check (Phase 2).
- `sqliteReplicaStorage({ dir, guard })` provides durable SQLite replicas partitioned by canonical identity (host + space + principal), durable `pending.json` state when a guard serializes mutations, a per-replica `syncedThroughEpoch` fence persisted only on successful sync, and purge across the deduplicated device union. Grant reuse reports `unconstrained` computed from the signed `att`; caveated grants are never installed. `@tinycloud/replica`, `/sqlite` and the WASM binding load lazily and require Node ≥ 22.13.
- `TinyCloudNode.planDelegation()` is the pure parent selection `delegateTo` runs; `replicationAuthority()` backs the controller's session/runtime grant strategies, refusing `CAVEATED_AUTHORITY` for caveat-only coverage.

Consumers that instantiate `TinyCloudNode` with `replication.enabled: true` must now supply `replication.storage`.
