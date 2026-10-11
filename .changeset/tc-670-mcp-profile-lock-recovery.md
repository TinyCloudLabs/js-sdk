---
"@tinycloud/mcp": patch
---

Hosted and self-hosted container MCP can recover a profile turn and `.lock` left by a crashed `tinycloud-mcp-http` PID 1 when the process restarts in the same container with its state volume intact. A recreated container with a new hostname or a host reboot still waits for manual lock recovery rather than risking a concurrent writer.
