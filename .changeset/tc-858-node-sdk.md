---
"@tinycloud/node-sdk": minor
---

Add the Phase 1 replication B-node surface for the TC-858 read-through flag: `sqliteReplicaStorage` (Node entry only), the per-prefix `ReplicationAuthority`, `planDelegation`/`replicationAuthority`, `replicationSignInEntries()`, and sign-in augmentation.

- `replication` config (enabled, prefixes, storage, allowSecrets) is validated at construction: storage is required, prefixes must be non-empty and non-overlapping, and `vault/` prefixes require `allowSecrets`.
- Sign-in requests gain one `{tinycloud.kv, space, prefix, [get, sync]}` entry per configured prefix already covered by an unrestricted `get` under the same `isCapabilitySubset` semantics the signed-recap check uses — an exact-path `get(notes)` never authorizes a `notes/private` entry, and secrets-primary coverage is measured against the effective secrets request, not `defaultActions`; `replicationSignInEntries()` returns the same augmentation the SIWE recap carries for the restore check (Phase 2).
- `sqliteReplicaStorage({ dir, guard })` provides durable SQLite replicas partitioned by canonical identity (host + space + principal), ALWAYS-durable `pending.json` pending state (never an in-memory fallback; a guard serializes cross-process read-modify-write), a per-replica `syncedThroughEpoch` fence persisted only on successful sync, and purge across the deduplicated device union. Purge bumps the replica's generation before removing it, so a handle opened beforehand fails `RESET_REQUIRED` on its next call. Grant reuse reports `unconstrained` computed from the signed `att`; caveated grants are never installed. `@tinycloud/replica`, `/sqlite` and the WASM binding load lazily and require Node ≥ 22.13.
- `TinyCloudNode.planDelegation()` is the pure parent selection `delegateTo` runs; `replicationAuthority()` backs the controller's session/runtime grant strategies, refusing `CAVEATED_AUTHORITY` for caveat-only coverage.
- The node now owns one lazy replication runtime across session replacement and restore. It binds to canonical host + primary space + principal, shares durable pending state for the same identity, attaches read-through only to primary-space KV services, and unbinds those services when the graph retires. Runtime controls expose status, sync, purge and pending cleanup; the runtime stays in the Node entry and does not enter the web bundle.
- Pending partition updates re-resolve the canonical path on every write and fail closed with `STORAGE_ERROR` after a symlink target changes. Existing unconstrained grants are reused only when parent/expiry policy permits; an offline mint cannot replace a constrained grant.

Consumers that instantiate `TinyCloudNode` with `replication.enabled: true` must now supply `replication.storage`.
Replication-enabled nodes must be imported from `@tinycloud/node-sdk`; the browser-safe `/core` entry does not register Node-only replication loaders.
