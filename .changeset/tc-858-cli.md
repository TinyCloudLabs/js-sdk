---
"@tinycloud/cli": minor
---

Add the opt-in replication flags, saved login prefixes, diagnostics log and report, bounded replication shutdown, and lease-safe logout cleanup for legacy and flag-owned replicas. The new login authority is limited to prefixes already covered by an unrestricted `get`; scoped logins are never broadened. Fresh local login still bootstraps missing profiles, key rotation preserves saved scoped permissions, and replication-enabled unscoped logins retain their full KV/SQL defaults.
