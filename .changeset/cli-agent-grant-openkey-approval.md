---
"@tinycloud/cli": minor
---

`tinycloud auth grant` on an OpenKey owner profile now always opens OpenKey so the owner approves each request, including `--preset apps-agent` requests. `--yes` no longer skips the approval. The owner CLI checks the approval's audience, expiry and scope before writing the grant file.

With no terminal attached, the approval link is printed and the command waits for the approval callback.
