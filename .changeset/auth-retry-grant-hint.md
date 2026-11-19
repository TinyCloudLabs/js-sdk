---
"@tinycloud/cli": patch
---

`auth retry` now says what to do when it finds nothing: `auth retry --last` re-checks the permission requests that `auth request` stores without `--grant`, so it never finds a stopped `auth request ... --grant`; the `REQUEST_NOT_FOUND` error says to run the same command again (same flags, same profile), which resumes the saved approval request.

Details: TC-3153
