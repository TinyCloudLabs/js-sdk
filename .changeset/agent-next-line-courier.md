---
"@tinycloud/courier": patch
---

Agents are now told, on stderr, to hand the owner the approval link and run the next command in the same turn. `courier init --request` ends its stderr with `Next: after sending the owner this link, run `courier init --wait --timeout 60s` now, in this same turn, without waiting for a reply.` (named as the user ran Courier, for example `tinycloud courier`). A pending `courier init --wait` (exit 8) ends its stderr with a line that tells the agent to send the link if it has not been sent yet and to run the same command again right away. `courier invite` prints a `Next:` line on stderr after the invitation link (which stays on stdout) that tells the agent to send the link to the owner now and then run `courier invite serve <id>`, and `courier invite serve` prints one before it starts waiting, repeating the saved invitation link (or pointing at the link `invite` printed when none is saved). stdout JSON and exit codes are unchanged, and other runs print no such line.

Details: TC-2360
