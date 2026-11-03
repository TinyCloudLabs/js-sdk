---
"@tinycloud/cli": patch
---

Agents are now told, on stderr, to hand the owner the approval link and re-run the command in the same turn. When `onboard --timeout`, `auth grant --timeout` or an approval-request login ends with exit 8 because the owner has not answered yet, stderr now ends with one `Next:` line after the link and the "Still waiting" message. The line puts the action first: for a link created in this run it says to send the owner the link above, then run the same command again now, in the same turn, without waiting for the owner to reply; for a resumed wait that reached its deadline it says to run the same command again now and to send the link first only if it has not been sent yet. stdout (`{"pending":{...}}`) and the exit code are unchanged, and no other exit prints the line.

Details: TC-2360
