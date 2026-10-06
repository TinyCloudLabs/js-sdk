# @tinycloud/replica

## 0.1.0-beta.0

### Minor Changes

- 37123c3: New package `@tinycloud/replica` (first beta): a durable, read-only local replica of one KV prefix, kept current over the node's `tinycloud.kv/sync` change feed (`kv-sync-v1`, TinyCloud Node with TC-732). It verifies every value against the node-attested blake3 ETag before committing, commits each feed page with its cursor in one transaction, enforces the node-attested authority window offline (optionally extended by a `tinycloud.kv/retain` grant), purges itself when it learns of a revocation, and resets in place on `410 RESET_REQUIRED`. `.` exports the engine, the frozen `ReplicaTransport`/`ReplicaStore` contracts, `kvSyncTransport(kv)` over `KVService.changes()` and the worker-safe `parseUcanGrant`; `./sqlite` is the Node/Bun store (built-in `node:sqlite` on Node 22.13+, `bun:sqlite` under Bun; no native addon).

  `tc replica sync|get|list|status|reset` (CLI): sync a prefix under a device grant carrying `tinycloud.kv/sync` and `tinycloud.kv/get`, then read it with the host offline. `get`, `list`, `status` and `reset` never touch the network. On Node.js older than 22.13 every `tc replica` command exits 1 with `RUNTIME_UNSUPPORTED`; other commands keep working on Node 20.
