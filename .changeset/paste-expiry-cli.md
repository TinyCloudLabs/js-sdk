---
"@tinycloud/cli": patch
---

The paste login and `tc auth request --grant --paste` now let you choose the session lifetime on the OpenKey page: their link carries `expiryChangeable=true`, so a lifetime longer than `--expiry` can be signed. The CLI saves the lifetime that was signed and accepts it only if it is more than 60 seconds away and at most 10 years away; beyond that it refuses with `OPENKEY_EXPIRY_EXCEEDED` (the message names the 10-year limit), and a signed lifetime of 60 seconds or less is refused with `OPENKEY_EXPIRY_TOO_SHORT`. A paste login no longer refuses before approval because `--expiry` is shorter than a live session; the check runs again on the signed lifetime when the login is saved. Signed approval requests, device login and the prepared replica and `--keys` logins never send the opt-in and keep the `--expiry` ceiling.

Details: TC-2276
