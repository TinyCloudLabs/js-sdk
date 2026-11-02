---
"@tinycloud/share-sdk": patch
"@tinycloud/cli": patch
"@tinycloud/sdk-core": patch
---

`revokeShare` on an addressed share now asks the adapter for every root the share created, the enforcement root and then the policy root, in one call, whatever `scope` says (`scope` now applies to bearer shares only). The result lists each root with what happened to it in a new `roots` field: `revoked`, or, for the policy-authority root only, `left-live` with its `expiresAt` when the adapter chose not to revoke it (`revokePolicyRoot` may now resolve `"left-live"` for that root). The share counts as revoked only when no root failed and at least one was revoked; otherwise `revokeShare` tries every root and throws the new `ShareRevocationIncompleteError` (`revoked`, `failed`), leaving the record unrevoked so a retry can finish. A `revokePolicyRoot` adapter must resolve for a root the Node already holds a revocation for. `@tinycloud/sdk-core` re-exports `ShareRevocationIncompleteError` and the new types. `tinycloud share revoke` revokes both roots, reports an incomplete revocation as `REVOCATION_INCOMPLETE`, and treats the Node's `root-revocation-irreversible` answer on a retry as already revoked.

Details: TC-2337
