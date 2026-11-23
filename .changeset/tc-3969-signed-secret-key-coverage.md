---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

`hasPermissions` and `hasRuntimePermissions` recognize exact secret-key permissions signed in the session, even when the same session has a bare encryption-network grant. An exact key does not cover a different key, a broader prefix or an unsigned action.

Details: TC-3969
