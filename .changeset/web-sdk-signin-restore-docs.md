---
"@tinycloud/web-sdk": patch
---

README: `signIn()` restores a stored session only when it covers the app's current manifest. The check is local and does not contact the node, so a session the node rejects is still restored; call `signOut()` before `signIn()` to force a fresh consent.

Details: TC-2267
