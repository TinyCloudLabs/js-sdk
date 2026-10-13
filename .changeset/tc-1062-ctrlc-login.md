---
"@tinycloud/cli": patch
---

Ctrl-C now cancels `tc auth login --method openkey` in a terminal, in both browser and `--paste` mode (TC-1062). Before, the login's interactive code prompt swallowed it and the login kept waiting until its 5-minute timeout. It now stops with `CANCELLED` (exit 130) and saves nothing.
