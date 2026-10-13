---
"@tinycloud/cli": patch
---

An `unverified` OpenKey owner session (one with no signed OpenKey proof, see TC-1053) no longer blocks recovery (TC-1059). A scoped or device login replaces it without `--replace-session`, instead of failing with `SESSION_IN_USE`. `tc secrets` treats it like a missing session and offers the sign-in, rather than failing with a permission error.
