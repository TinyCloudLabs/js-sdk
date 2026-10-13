---
"@tinycloud/cli": patch
---

`tc auth status` and `tc auth whoami` no longer report an expired session as signed in (TC-973). `authenticated` is now true only when the stored session has not expired, or has no recorded expiry. Both commands also report `session: { state, expiresAt }` in their JSON, with the same states as `tc context`: `missing`, `expired`, `present` or `unknown-expiry`. Human output gains a `Session` line, and `auth status` prints the sign-in command when the session has expired. The exit status is still 0.
