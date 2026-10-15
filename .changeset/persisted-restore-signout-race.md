---
"@tinycloud/web-sdk": patch
---

A pending persisted-session restore or delegation activation no longer resumes after `signOut()` if it was waiting for storage or SDK initialization. The signed-out session stays inactive, and a later explicit sign-in can start a new session.
