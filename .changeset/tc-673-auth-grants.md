---
"@tinycloud/cli": minor
---

Add `tc auth grants list` for local verification and inspection of stored grants without a network request, and `tc auth grants remove <cid> [--revoke]` for deleting matching local records. Local removal is available to delegates; only `--revoke` is owner-only and removes local rows after successful node revocation.

Cross-user imports appear as `for_another_key` in the local list rather than as broken bindings. `--revoke` uses the usual verified local-node discovery. If node revocation succeeds but local removal fails, `GRANT_REVOKED_LOCAL_REMOVE_FAILED` directs the owner to retry local removal without revoking again.
