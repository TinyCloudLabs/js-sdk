---
"@tinycloud/sdk-services": patch
---

Replication: add the shared replica contract types for browser and node/CLI storage adapters — the lifecycle gate and session stamp, grant-lifetime policy, quota seams, and new optional options (`grantTtlMs`, `maxBytes`, `minFreeBytes`), status fields and events. New subpaths `@tinycloud/sdk-services/kv/replication/contractConstants` and `/grantPolicyTypes`. Types and constants only; behaviour is unchanged.
