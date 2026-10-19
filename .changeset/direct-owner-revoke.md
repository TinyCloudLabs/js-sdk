---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
---

Wallet-backed `TinyCloudNode.revokeDelegation(cid)` now signs a direct owner revocation for the target CID. Session-only clients continue to use their delegated revocation authority; the node receipt must confirm the requested CID (TC-721, TC-821).
