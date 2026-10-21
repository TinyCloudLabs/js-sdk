---
"@tinycloud/courier": patch
---

Classify conditional-write and read failures from structured error fields (`code`, `status`, `meta.status`) only, never from message text. Previously the storage key was matched against a 412 pattern, so a non-412 failure on a key containing the digits `412` could be reported as a write conflict and silently skipped. Missing-key detection and transient read retries use the same structured fields.

Details: TC-1684
