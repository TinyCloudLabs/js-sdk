---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-services": patch
---

`TinyCloudWeb.signOut()` now ends the session on the instance, through the new `TinyCloudNode.signOut()`: session accessors return `undefined`, the session key is replaced, pending requests are aborted, and service calls fail instead of acting for the signed-out user. A sign-in or restore still in progress when sign-out is called does not establish its session; a later `signIn()` or `restoreSession()` starts a fresh one.

`useDelegation()` results now belong to the session that created them: they stop working when that session signs out or is replaced by another `signIn()` or `restoreSession()`.
