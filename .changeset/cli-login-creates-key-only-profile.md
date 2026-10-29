---
"@tinycloud/cli": patch
---

`tinycloud auth login --method openkey` on a profile that does not exist now creates a key-only profile (a local key, as `init --key-only` does) and continues into the login, instead of failing with `PROFILE_NOT_FOUND`. Nothing is granted until the owner approves; abandoning the login leaves a key-only profile with no session. `auth logout` on a missing profile still fails and creates nothing.

Details: TC-2212
