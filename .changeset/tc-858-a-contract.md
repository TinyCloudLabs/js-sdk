---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
---

Add the Phase 1 replication contract, canonical identity and scope helpers, network-only KV read option, and nullable KVService read-through seam. With the seam unset, KV operations retain their existing network behavior. Pending-write stores declare whether their committed epoch and records survive restarts; for non-durable stores, controllers must require a successful in-process sync before serving local reads, otherwise use the network with `REPLICA_UNPROVEN_SINCE_START`. Node/CLI adapters must provide durable pending state and fail closed to network reads rather than silently falling back to memory.
