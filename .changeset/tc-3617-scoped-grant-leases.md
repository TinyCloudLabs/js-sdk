---
"@tinycloud/node-sdk": minor
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

Scoped grants can carry the owner's renewal lease.

- `activateValidatedRuntimeDelegation` takes `renewal: { leaseAuthorization }`. A wallet-signed grant past its signed expiry is then installed until the end its verified renewal stamps give it; a renewal that ended or names a replaced renewer is refused as `expired` and a node that cannot answer is `activation_unavailable`.
- `TinyCloudNode.getDelegationRenewalEffectiveExpiry` checks one owner-signed delegation's renewal. `verifySessionGrant` takes `allowExpired`.
- The `tinycloud.auth.delegation` import artifact takes an optional `renewal`, which is stored with the delegation. Replay keeps such a grant past its signed end while its lease is live.
- Hosted MCP per-request approvals ask for the same 90-day lease as the connection approval. An approved lease is checked and admitted at the node before the grant is imported.

Details: TC-3617
