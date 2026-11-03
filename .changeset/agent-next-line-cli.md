---
"@tinycloud/cli": patch
---

Agents are now told, on stderr, to write the approval link to the owner in their reply and re-run the command in that same reply. When `onboard --timeout`, `auth grant --timeout` or an approval-request login ends with exit 8 because the owner has not answered yet, stderr now ends with one `Next:` line after the link and the "Still waiting" message. The line names the exact command as it was run (with the program name `tc` or `tinycloud`). For a link created in this run it says to write the link above in the reply to the owner now and, in that same reply, run that command again, without ending the turn or waiting for a reply; for a resumed wait that reached its deadline it says to write the link first only if it has not been written yet, then run that command again in the same reply. It never claims the owner already has the link. stdout (`{"pending":{...}}`) and the exit code are unchanged, and no other exit prints the line.

Details: TC-2360
