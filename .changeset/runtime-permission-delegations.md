---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Store approved runtime permissions as narrow portable delegations and route matching invocations through them instead of expanding the app manifest and re-signing the whole session. `delegateTo()` can now derive from an installed runtime delegation, web permission requests return any created runtime delegations, and the secrets wrapper can use the SDK's connected signer when unlocking the backing vault.
