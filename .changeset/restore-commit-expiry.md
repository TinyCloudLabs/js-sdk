---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

`restoreSession()` and `restoreSessionWithRenewal()` check the session's expiry again just before installing it. A session that expired while the restore was waiting, for example on a pending account-registry sync, is now refused with `InvalidRestoredSessionError` instead of being installed and then failing every call against the node.

In the web SDK, a restore whose session another instance on the same storage signed out while the node was restoring it now ends that node session and returns `"missing"` instead of `"restored"`.

Details: TC-2936
