---
"@tinycloud/cli": patch
---

`tc auth grant` on an OpenKey profile no longer caps an agent grant at 7 days. The OpenKey approval is requested for the lifetime the agent's request names (for example `--expiry 30d`), and the grant lasts as long as the owner's approval. A request that names no lifetime still gets 7 days. The scope text printed before the approval states the requested lifetime ("It lasts up to 30 days"), not the old cap. Revocation, not expiry, is how the owner cuts an agent off early: `tc delegation revoke <id>`, or the account site.

Details: TC-2532
