---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

`tc share revoke <id>` now revokes public (anyone-with-the-link) shares, and receiving a revoked link fails. Before, the node refused the revocation with 403 and the link stayed readable until it expired.

- **Error codes.** Every failure exits nonzero and revokes nothing.
  - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link.
  - `SHARE_LINK_UNAVAILABLE` (exit 1): the stored link is missing or doesn't match the record.
  - `SHARE_REVOKE_REJECTED` (exit 7): the node refused, or its reply didn't confirm the CID. The message includes the node's reason.
- **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`.
- **sdk-core.** `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`. This is an addition only.
- **node-sdk.** New `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.
