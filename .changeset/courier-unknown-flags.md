---
"@tinycloud/courier": patch
---

Courier refuses a flag the command does not accept: it exits 2 with `Unknown flag --name for <command>` and the accepted flags, before reading stdin or a grant file or touching the profile.

Details: TC-2343
