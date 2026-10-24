---
"@tinycloud/courier": minor
---

`courier revoke <peer>` now revokes every unexpired outbound delegation recorded for the peer on the node, so the peer's next read is refused with `delegation-revoked`. If the node refuses any delegation the command exits non-zero with `revoke-failed` naming the delegation ids, keeps the peer and its `me/peers/` record, and a re-run retries only the delegations not yet revoked. The peer is dropped only after all of them are revoked. Expired delegations are skipped and reported.

New installs can revoke: grants requested by `courier init` now include `tinycloud.delegation/revoke` on the `agents` space, which the node requires for the courier key to revoke its own delegations. Existing installs keep working unchanged, because that entry is optional in the grant check; on them `courier revoke` exits `revoke-not-enabled` before any node call and changes nothing. Re-run `courier init` once to enable revoke. Minor because new grants carry an extra entry and `revoke` gains a new behaviour and error codes.

Details: TC-712
