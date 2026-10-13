---
"@tinycloud/cli": patch
---

`tc doctor` no longer reports a healthy node as down (TC-1048). It probed `/health`, which TinyCloud nodes answer with 404, and now probes `/healthz`, as `tc node health` does. Its Session check now fails for an expired session and prints the command to sign in again, instead of reporting it as active.
