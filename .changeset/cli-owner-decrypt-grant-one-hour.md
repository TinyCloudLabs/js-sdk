---
"@tinycloud/cli": patch
---

`tc secrets network grant` now takes `--expiry` (default `1h`) and passes the lifetime to the grant explicitly instead of the SDK's 30-day default; a lifetime over one hour is refused with `DECRYPT_EXPIRY_TOO_LONG` (exit 2) before anything is signed. `tc delegation create` refuses a delegation that includes decrypt when `--expiry` is over one hour; delegations without decrypt keep their lifetime. The live delegated-secrets smoke script requests a one-hour grant.

Details: TC-1781
