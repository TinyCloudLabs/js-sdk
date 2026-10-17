---
"@tinycloud/cli": patch
---

Fence unchanged inactive replica gates across online logout, reject changed gates before local credential removal, and give an actionable retry path for an interrupted orphan logout marker. A plain `auth logout` retry now resumes a committed local logout whose credential removal failed, instead of asking to discard local changes; it refuses without changes when the pending logout belongs to a different principal than the current session.
