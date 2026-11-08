---
"@tinycloud/cli": patch
---

`tc auth grant` on an OpenKey profile no longer caps an agent grant at 7 days. The OpenKey approval is requested for the lifetime the agent's request names (for example `--expiry 30d`), and the grant lasts as long as the owner's approval. A request that names no lifetime still gets 7 days. The scope text printed before the approval states the requested lifetime ("It lasts up to 30 days"), not the old cap. Revocation, not expiry, is how the owner cuts an agent off early: `tc delegation revoke <id>`, or the account site.

When OpenKey signs a shorter lifetime than the request asked for (the owner's choice, or OpenKey's own limit, 30 days today), the grant follows the approval and stderr says so in one line, for example `OpenKey granted this for 30 days (you asked for 90 days).`

Details: TC-2532
