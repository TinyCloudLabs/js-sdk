---
"@tinycloud/web-sdk": patch
---

Import the share recipient surface from `@tinycloud/share-sdk/web-recipient` instead of the share-sdk package root, so the built bundle no longer carries the rest of share-sdk. No runtime API change.

Details: TC-1757
