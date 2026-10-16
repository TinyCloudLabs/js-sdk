---
"@tinycloud/sdk-services": patch
---

Add the node/CLI `ProfileReplicaPurge` deferred-revoke and discriminated logout-marker types. Document token-fenced replay, orphan-profile wipe with discard consent when local writes are indeterminate, and durable signed-out credential cleanup on plain or successful remote logout, including the no-marker path. Failed remote revoke retains credentials and physical replicas; the browser lifecycle interface is unchanged.
