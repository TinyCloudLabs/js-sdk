---
"@tinycloud/cli": minor
---

`tinycloud auth login --renew <duration>` asks the owner, in the signed approval, to let the node keep this login working past its expiry for up to that long (such as `90d` or `1y`, at most one year); the owner chooses the length in OpenKey. It works only with the signed-request sign-in and is refused with `--paste`, `--device`, `--keys` and replica sign-ins. The approval link is printed with a line saying how long the permission can renew itself, and the pending-approval output (`{"pending":{...}}`, exit 8) carries `renewalLeaseSeconds` when the request asks for a renewal. The finished login prints `renewalEndsAt` when a renewal was granted. Without the flag nothing changes. The flag needs an OpenKey that supports renewal approvals; an older OpenKey refuses the request.

Details: TC-2904
