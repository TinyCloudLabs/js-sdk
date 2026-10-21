---
"@tinycloud/courier": patch
---

Classify conditional-write 412 responses from the response status and server message only. Previously the storage key was also matched, so a non-412 failure on a key containing the digits `412` could be reported as a write conflict and silently skipped.
