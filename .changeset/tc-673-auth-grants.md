---
"@tinycloud/cli": minor
---

Add `tc auth grants list` for local verification and inspection of stored grants without a network request, and `tc auth grants remove <cid> [--revoke]` for deleting matching local records. Local removal is available to delegates; only `--revoke` is owner-only and removes local rows after successful node revocation.

Cross-user imports appear as `for_another_key` only when their CID and signed audience verify and match the stored transport audience; tampered rows retain their refusal reason. `--revoke` uses the usual verified local-node discovery. A concurrent local removal after node revocation succeeds with `removed: 0`; other local removal failures return `GRANT_REVOKED_LOCAL_REMOVE_FAILED` with a structured cause code and a hint to retry local-only.
