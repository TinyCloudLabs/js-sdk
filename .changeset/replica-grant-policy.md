---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
---

Replication: add the grant lifetime policy functions (`@tinycloud/sdk-services/kv/replication/grantPolicy`: consent deadline, effective expiry, mint duration, silent-renewal check) and validate `replication.grantTtlMs` in node-sdk (positive, at most 7 days). No behaviour change until a replica is configured with a grant policy.
