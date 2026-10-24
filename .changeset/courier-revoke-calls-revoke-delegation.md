---
"@tinycloud/courier": minor
---

`courier revoke <peer>` now revokes every unexpired outbound delegation recorded for the peer on the node, so the peer's next read is refused with `delegation-revoked`. If the node refuses any delegation the command exits non-zero with `revoke-failed` naming the delegation ids, keeps the peer and its `me/peers/` record, and a re-run retries only the delegations not yet revoked. The peer is dropped only after all of them are revoked. Expired delegations are skipped and reported.

The owner-approved agent grant gains `tinycloud.delegation/revoke` on the `agents` space, which the node requires for a delegator to revoke its own delegations. Grants issued before this change are refused with `grant-incomplete`: run `courier init` once to renew. Minor because the grant shape changes.

Details: TC-712
