---
"@tinycloud/cli": patch
---

Local-key grants that include `tinycloud.encryption/decrypt` (or `tinycloud.encryption/*`) now last at most one hour: `tc auth request --grant` shortens a longer requested lifetime to one hour and says so on stderr, and `tc auth grant` refuses a decrypt request over one hour or with no lifetime before anything is signed. A decrypt lifetime the SDK refuses as too long is reported as `DECRYPT_EXPIRY_TOO_LONG` (exit 2). Requests without decrypt keep their lifetime.

Details: TC-1781
