---
"@tinycloud/courier": minor
---

`courier pair renew <peer> --artifact` emits a fresh C artifact for one already-paired peer without requiring the issuer's inbound delegation. The receiver can install it with `courier pair accept`; both sides preserve the established peer and exact mailbox scope, and the renewed delegation remains limited to seven days.

Details: TC-712
