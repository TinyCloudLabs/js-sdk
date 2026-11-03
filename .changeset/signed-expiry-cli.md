---
"@tinycloud/cli": patch
---

The prepared OpenKey login accepts a shorter session lifetime picked on the OpenKey page instead of refusing the signed message, and saves the lifetime that was signed. A lifetime beyond the requested `--expiry` (plus 30 seconds) is still refused with `OPENKEY_EXPIRY_EXCEEDED`. The replica login now builds its node with the requested `--expiry` as the session lifetime, as the `--keys` login already did.

Details: TC-2276
