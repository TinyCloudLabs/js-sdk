---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

Scoped grants can carry the owner's renewal lease.

- `activateValidatedRuntimeDelegation` takes `renewal: { leaseAuthorization }`. A wallet-signed grant past its signed expiry is then installed until the end its verified renewal stamps give it. A renewal that ended, was stopped, was never stamped or names a replaced renewer is refused as `expired`; a lease that does not bind the grant or stamps that do not verify are `authority_invalid`; a node that cannot answer is `activation_unavailable`.
- `TinyCloudNode.getDelegationRenewalEffectiveExpiry` checks one owner-signed delegation's renewal. `verifySessionGrant` takes `allowExpired`.
- `verifyRenewalHistory` (`@tinycloud/sdk-core/delegations/renewal`) throws coded errors: `RENEWAL_NOT_STAMPED` when the node holds no stamp for the lease, `RENEWAL_HISTORY_INVALID` when its stamps do not verify and `RENEWAL_AUTHORITY_INACTIVE` when the latest stamp has ended. A lease that does not authorize only the delegation fails with `RENEWAL_LEASE_MISMATCH`. `OwnerRenewalMismatchError` and `RENEWAL_LEASE_MISMATCH` are exported from `@tinycloud/sdk-core/delegations/renewal` as well as from `@tinycloud/sdk-core/delegations/renewal-receipt`.
- The `tinycloud.auth.delegation` import artifact takes an optional `renewal`, which is stored with the delegation. Replay keeps such a grant past its signed end while its lease is live.
- Hosted MCP per-request approvals ask for the same 90-day lease as the connection approval. An approved lease is checked and admitted at the node before the grant is imported.

Details: TC-3617
