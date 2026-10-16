---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

A pending persisted-session restore or delegation activation no longer resumes after `signOut()` if it was waiting for storage or SDK initialization. The signed-out session stays inactive, and a later explicit sign-in can start a new session. If replacement session-key creation fails during sign-out, the node still retires the old authority and clears its persisted session.
