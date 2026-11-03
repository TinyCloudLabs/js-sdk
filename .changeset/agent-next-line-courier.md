---
"@tinycloud/courier": patch
---

Agents are now told, on stderr, to hand the owner the approval link and run the next command in the same turn. `courier init --request` ends its stderr with `Next: after sending the owner this link, run `courier init --wait --timeout 60s` now, in this same turn, without waiting for a reply.` (named as the user ran Courier, for example `tinycloud courier`). A pending `courier init --wait` (exit 8) ends its stderr with a line that tells the agent to send the link if it has not been sent yet and to run the same command again right away. stdout JSON and exit codes are unchanged, and successful or failed runs print no such line.

Details: TC-2360
