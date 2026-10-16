---
"@tinycloud/replica": patch
---

Add `@tinycloud/replica/kv-storage`: `indexedDbReplicaStorage()`, the browser `ReplicaGatedStorage` for read-through replication. All replicas live in one IndexedDB database per origin (`tinycloud-replica-kv`) and are synced by a dedicated worker (`kv-storage.worker.js`) that runs the existing engine. Reads carry `LocalReadMeta`; grants report CID, parent, state, expiry and `unconstrained`, and caveated get/sync grants are refused; `sync({ signal })` cancels in the worker and commits nothing past the last complete page; `syncStartEpoch` is persisted with the sync's completion only after pages, repairs and GC; injected and stored devices get separate partitions and `purge` covers both without opening; pending writes are durable and serialised across tabs; other tabs' commits reach `onPeerCommit`. Test-only fault seams are in `@tinycloud/replica/kv-storage/testing`. The `openReplica` API (`@tinycloud/replica/browser`) and its per-replica databases are unchanged.

Policy-only expiry returns `GRANT_EXPIRED` without deleting the account keys; only the fixed durable gate deadline returns `CONSENT_EXPIRED` and triggers key shredding.
