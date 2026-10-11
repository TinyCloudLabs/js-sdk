---
"@tinycloud/cli": patch
---

`tc` recovers a profile lock left by a crashed process with its own PID in another PID namespace (a container restarted with a persistent `TC_HOME`) and still waits for a live or paused one. The tc-cli reference documents the conditions, what still waits, and the manual remedy for `$TC_HOME/.tinycloud` and per-tenant MCP state, and restores the caveat that the lock does not protect processes with different PIDs in different PID namespaces.
