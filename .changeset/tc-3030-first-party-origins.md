---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

Remove one non-public origin from `FIRST_PARTY_ORIGINS`. Pages served from that origin no longer receive implicit first-party bootstrap permissions at sign-in. All other first-party origins and Pages projects are unchanged.

Details: TC-3030
