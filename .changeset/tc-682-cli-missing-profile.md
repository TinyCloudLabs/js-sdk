---
"@tinycloud/cli": patch
---

`tc auth logout` and `tc auth login` (OpenKey) now fail with `PROFILE_NOT_FOUND` when the selected profile does not exist. Logout used to report `{"authenticated":false}` for a profile that was never created, and login reported `NO_KEY` with a `tc init` hint that targets the `default` profile. The missing-profile error now suggests `tc init --name <profile>`, and `NO_KEY` on an existing profile suggests `tc --profile <profile> auth rotate`.
