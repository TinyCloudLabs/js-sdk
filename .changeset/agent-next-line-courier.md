---
"@tinycloud/courier": patch
---

Agents are now told, on stderr, to hand the owner the link and run the next command in the same turn. Each `Next:` line puts the action first, in one sentence, and names the exact command in backticks, written as the user ran Courier (`courier` or `tinycloud courier`). `courier init --request` ends its stderr with a line that says to send the owner the link above now, then run `init --wait --timeout 60s` right away. A pending `courier init --wait` (exit 8) ends with a line that names the same command again: for a link created in this run, send the link, then run it again right away; for a resumed request, run it again now and send the link first only if it has not been sent yet. A pending `courier invite --wait` ends its stderr, after the existing `[invite-pending]` line, with a line that says to send the invitation link (which stays on stdout) to the owner now, then run `invite serve <id> --wait 60`. `courier invite serve` prints, at the start of every run, a line with the saved invitation link to send if it has not been sent yet, and, if it ends pending, a last line after `[invite-pending]` that says no one has joined yet and to run the same command again now. A claimed invitation prints no run-again line. stdout JSON and exit codes are unchanged, and other runs print no such line.

Details: TC-2360
