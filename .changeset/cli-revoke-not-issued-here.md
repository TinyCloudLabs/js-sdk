---
"@tinycloud/cli": patch
---

`tc delegation revoke` now refuses a delegation that another account issued before asking for any signature, with exit code 5 and a message naming the issuer as the one to revoke it.

Details: TC-2132
