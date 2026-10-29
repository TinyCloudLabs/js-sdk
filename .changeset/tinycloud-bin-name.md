---
"@tinycloud/cli": minor
---

Make `tinycloud` the preferred CLI command and rename the core skill to `tinycloud-cli`. Keep `tc` as a deprecated compatibility alias at the same entry, with identical commands, flags, exit codes, and stdout. Invoking the alias through a POSIX executable link emits one deprecation notice on stderr; existing scripts and piped JSON keep working.

Details: TC-2202
