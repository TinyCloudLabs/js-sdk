---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Automatically ensure owner-owned encryption networks exist during manifest-driven sign-in. When a requested `tinycloud.encryption/decrypt` permission targets the signed-in user's network ID, the SDK adds a separate scoped `tinycloud.encryption/network.create` sign-in grant and `signIn()` creates the network if the node reports it missing.
