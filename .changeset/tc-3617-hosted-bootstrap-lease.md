---
"@tinycloud/mcp": minor
---

The hosted MCP's connection approval asks the owner for a 90-day renewal lease. An approved lease is checked against the signed grant and admitted at the node before the session is stored, and the session keeps it, so the node renews the account grant until the lease ends. A lease that does not match the grant, was issued to a renewer the node replaced or comes with a grant ending within 15 minutes is refused and logged with stage `renewal`; a node that cannot admit the lease yet leaves the approval for the next collection. Past the grant's signed end, a session whose lease has ended or whose renewer changed starts a fresh connection approval, and a node that cannot answer reports the account unavailable.

Collection waits at most 3 seconds per call in total, reads at most 256 KiB of each OpenKey result reply, recovers a claimed result by the time recorded in the claim, collects for at most 10 minutes after a request ends and opens a new request when a stored one names other OpenKey origins.

Details: TC-3617
