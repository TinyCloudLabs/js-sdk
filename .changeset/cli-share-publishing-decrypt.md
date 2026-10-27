---
"@tinycloud/cli": patch
---

`builtin:share-publishing` (and `enable share`) now also asks for decrypt on the account's own default key, and device sign-in accepts that one entry, so a profile approved with only that manifest can create email-addressed shares.

Details: TC-2177
