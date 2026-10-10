---
"@tinycloud/cli": minor
---

Add the opt-in replication flags, saved login prefixes, diagnostics log and report, bounded replication shutdown that forces a successful exit after a stalled drain, and lease-safe logout cleanup under one profile lock for legacy and flag-owned replicas. Registrations arriving during shutdown are drained before completion. The new login authority is limited to prefixes already covered by an unrestricted `get`; scoped logins are never broadened. Fresh local login still bootstraps missing profiles, key rotation preserves saved scoped permissions, and replication-enabled unscoped logins retain their full KV/SQL defaults.

The CLI now supplies profile-partitioned SQLite storage to the node runtime and registers the node's live replication control surface for reports. Secret/vault existence reads that determine CLI behavior bypass local replicas and remain network-authoritative. Replication profile writes are serialized by the profile guard; with `TC_REPLICATION` unset, no replica store is opened.

`TC_REPLICATION_VERIFY=1` now forwards the verification policy to the node runtime; with the flag unset, CLI replication remains disabled and creates no replication directory.
