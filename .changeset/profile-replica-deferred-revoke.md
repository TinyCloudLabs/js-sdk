---
"@tinycloud/sdk-services": patch
---

Add the node/CLI `ProfileReplicaPurge` deferred-revoke and discriminated logout-marker types. Document token-fenced replay, orphan-profile wipe with explicit local-write discard consent, durable signed-out provenance and credential cleanup on plain or successful remote logout. Failed remote revoke retains credentials and physical replicas; the browser lifecycle interface is unchanged.
