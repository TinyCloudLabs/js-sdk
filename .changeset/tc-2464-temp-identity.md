---
"@tinycloud/courier": patch
---

Courier now persists a private identity sidecar before writing key-bearing temp bytes. Recovery scrubs a temp only when its recorded identity and liveness prove the writer is gone; missing, malformed, or foreign host/PID-namespace metadata keeps the temp and reports platform-specific manual recovery guidance (`rm -f --` or PowerShell `Remove-Item -LiteralPath`). Operators must confirm no Courier writer anywhere could still be writing the temp or sidecar before using that command. After a successful rename, Courier syncs the installed target before best-effort sidecar removal; orphan sidecars are handled conservatively.

Details: TC-2464
