---
"@tinycloud/cli": patch
---

`tc` recovers a profile lock left by a crashed process with its own PID in another PID namespace (a container restarted with a persistent `TC_HOME`) once that process's liveness socket in the shared turn directory is gone or refused by the kernel, and still waits for a live or paused one, for one whose socket it cannot verify (a turn directory it does not share, or a sandbox that blocks its own connections), and for older releases. The tc-cli reference documents each condition, what still waits, and the manual remedy for `$TC_HOME/.tinycloud` and per-tenant MCP state, and restores the caveat that the lock does not protect processes with different PIDs in different PID namespaces.
