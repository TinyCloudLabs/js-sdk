---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Signing out now starts clearing the saved session before it waits for background cleanup, in the Node and browser SDKs. Storage-adapter interfaces are unchanged.

Details: TC-2379
