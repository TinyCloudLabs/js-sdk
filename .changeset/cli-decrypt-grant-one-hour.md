---
"@tinycloud/cli": patch
---

Local-key grants that include `tinycloud.encryption/decrypt` now last at most one hour: `tc auth request --grant` and `tc auth grant` shorten a longer requested lifetime to one hour and say so on stderr. A decrypt lifetime the SDK refuses as too long is reported as `DECRYPT_EXPIRY_TOO_LONG` (exit 2). Grants without decrypt keep their lifetime.

Details: TC-1781
