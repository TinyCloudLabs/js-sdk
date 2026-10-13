---
"@tinycloud/cli": patch
---

`tc auth status` and `tc auth whoami` no longer report an expired session as signed in (TC-973). `authenticated` is now true only when the stored session has not expired, or has no recorded expiry. A signed SIWE `Expiration Time` takes precedence over unsigned expiry metadata, as it does when commands restore the session. Both commands also report `session: { state, expiresAt }` in their JSON, using the same evaluation as `tc context` (`missing`, `expired`, `present` or `unknown-expiry`); `tc context` now applies the same SIWE precedence to its `expiresAt`. Human output gains a `Session` line, and `auth status` prints the sign-in command when the session has expired. The exit status is still 0.
