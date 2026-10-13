---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

`tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.

- **Error codes for bearer revokes.**
  - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
  - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
  - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
  - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
- **History.** Revoking an already revoked share keeps its original `revokedAt`.
- **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
- **sdk-core.** These are additions only:
  - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
  - The new `parseSignedSiweCacao(authorization, expectedCid?)` checks a wallet SIWE CACAO's exact-bytes CID and EIP-191 signature, and returns its issuer, audience and ReCap attenuation.
- **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.
