---
"@tinycloud/cli": patch
---

Agents are now told, on stderr, to hand the owner the approval link and re-run the command in the same turn. When `onboard --timeout`, `auth grant --timeout` or an approval-request login ends with exit 8 because the owner has not answered yet, stderr now ends with one `Next:` line after the link and the "Still waiting" message. A link created in this run says to send it now and run the same command again right away, without waiting for a reply; a resumed wait that reached its deadline says to send the link if it has not been sent yet, then run the same command again right away. stdout (`{"pending":{...}}`) and the exit code are unchanged, and no other exit prints the line.

Details: TC-2360
