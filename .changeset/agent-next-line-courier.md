---
"@tinycloud/courier": patch
---

Agents are now told, on stderr, to hand the owner the link and run the next command in the same turn. The `Next:` line puts the action first and names the exact command, written as the user ran Courier (`courier` or `tinycloud courier`). `courier init --request` ends its stderr with a line that says to send the owner the link above, then run `init --wait --timeout 60s` now. A pending `courier init --wait` (exit 8) ends with a line that names the same command again: for a link created in this run, send the link, then run it again now; for a resumed request, run it again now and send the link first only if it has not been sent yet. When `courier invite` or `courier invite serve` ends pending (`invite-pending`, exit 1), its stderr now ends with a `Next:` line after the existing error line: for `invite`, send the invitation link (which stays on stdout) to the owner before anything else, then run `invite serve <id> --wait 60`; for `invite serve`, send the saved invitation link (or the one `invite` printed) if it has not been sent yet, then run the same command again. A claimed invitation prints no such line. stdout JSON and exit codes are unchanged, and other runs print no such line.

Details: TC-2360
