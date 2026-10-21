---
"@tinycloud/cli": minor
---

`tinycloud auth grant` on an OpenKey owner profile now sends every agent request to OpenKey, including `--preset apps-agent` requests with no extra entries, so the owner approves each one. `--yes` no longer skips that approval; it skips only the extras confirmation. The grant lasts as long as the approval allows, and requests are capped at 7 days.

With no terminal attached, the approval link is printed and the command waits for the browser flow to finish.
