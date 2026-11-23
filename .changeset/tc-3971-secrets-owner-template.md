---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Secrets permission checks use the signed-in owner's resolved manifest when the app declares an encryption path with `{owner}`. The template remains unchanged for sign-in. Apps can read secrets sealed to the network key and write secrets without asking again for permissions already granted.

Details: TC-3971
