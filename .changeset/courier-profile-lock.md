---
"@tinycloud/courier": patch
---

Courier holds `profile.json.lock` only while it reads or saves the profile, not during network operations, and saves are safe when several Courier commands run at once. When a running process holds the lock, the error names its pid. `watch` logs a profile lock timeout and retries.

Details: TC-3431
