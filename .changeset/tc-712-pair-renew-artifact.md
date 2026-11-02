---
"@tinycloud/courier": minor
---

`courier pair renew <peer> --renew-artifact` emits a fresh C artifact for one already-paired peer without requiring the issuer's inbound delegation. The receiver can install it with `courier pair accept`; both sides preserve the established peer and exact mailbox scope, and the renewed delegation remains limited to seven days. Export is rate-limited to one renewal per peer per 20 hours unless the owner passes `--force`; no automatic renewal is added.

Details: TC-712
