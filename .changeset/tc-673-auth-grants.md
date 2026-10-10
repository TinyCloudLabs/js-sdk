---
"@tinycloud/cli": minor
---

Add `tc auth grants list` for local verification and inspection of stored grants without a network request, and `tc auth grants remove <cid> [--revoke]` for deleting matching local records. Local removal is available to delegates; only `--revoke` is owner-only and removes local rows after successful node revocation.
