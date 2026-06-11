---
"@tinycloud/cli": patch
---

Add `tc status` to show local profile, session, delegation, and permission state in human and JSON formats.

TinyCloud secrets commands now request the required owner delegation and retry once when a secrets operation fails because the active session or permission grant is missing or expired.
