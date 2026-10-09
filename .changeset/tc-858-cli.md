---
"@tinycloud/cli": minor
---

Add the opt-in replication flags, saved login prefixes, diagnostics log and report, awaited replication shutdown, and logout cleanup for flag-owned replicas. The new login authority is limited to prefixes already covered by an unrestricted `get`; scoped logins are never broadened.
