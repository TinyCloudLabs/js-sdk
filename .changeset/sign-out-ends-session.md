---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-services": patch
---

`TinyCloudWeb.signOut()` now ends the session on the instance, through the new `TinyCloudNode.signOut()`: session accessors return `undefined`, the session key is replaced, and service calls (including services and `useDelegation()` results obtained before sign-out) fail instead of acting for the signed-out user. A later `signIn()` or `restoreSession()` on the same instance starts a fresh session.
