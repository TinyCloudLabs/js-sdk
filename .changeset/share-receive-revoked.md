---
"@tinycloud/cli": patch
---

`tc share receive` on a revoked bearer link now fails with `SHARE_REVOKED` (exit 4, "This share link has been revoked by its sender.") instead of the generic `INVALID_ARGUMENT: share operation failed`.
