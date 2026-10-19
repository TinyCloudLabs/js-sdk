---
"@tinycloud/cli": patch
---

`auth logout` denies the profile's replica gate durably before it removes `session.json` and `key.json`, then erases local replicas. If the gate cannot be denied, credentials and replicas stay in place and the command exits with a retryable error. Fence unchanged inactive replica gates across online logout, reject changed gates before local credential removal, and give an actionable retry path for an interrupted orphan logout marker. A plain `auth logout` retry now resumes a committed local logout whose credential removal failed, instead of asking to discard local changes. Logout and startup recovery refuse without changes when the pending logout belongs to a different principal than the current session.
