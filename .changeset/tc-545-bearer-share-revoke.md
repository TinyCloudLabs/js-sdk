---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
"@tinycloud/sdk-core": patch
---

`tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Receiving a revoked link fails. Before, the node refused the revocation with 403 and the link stayed readable until it expired. If this profile cannot revoke a link, the command exits 5 with `SHARE_ISSUER_KEY_UNAVAILABLE` and nothing is revoked. The share SDK passes the share record to `ShareRevocationAdapter.revokeDelegation`, and `parseSignedCompactUcanAttenuation` also returns the verified issuer (`payload.iss`).
