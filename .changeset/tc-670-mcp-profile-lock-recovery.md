---
"@tinycloud/mcp": patch
---

A restarted `tinycloud-mcp-http` container (PID 1, same host boot, state volume kept) recovers the profile turn and `.lock` its crashed predecessor held (`.lock` once 30 s old) instead of waiting forever; a live MCP sharing the volume from another container is still waited for. After a host or VM reboot, a volume moved to another machine, or a predecessor from an older release, the wait remains: with no MCP or `tc` process using the profile, remove `$TC_MCP_STATE_DIR/tenants/<tenant>/.tinycloud/profile-locks/agent` and `$TC_MCP_STATE_DIR/tenants/<tenant>/.tinycloud/profiles/agent/.lock`.
