---
"@tinycloud/cli": patch
---

`feed connect` checks `--to` is a DID before it reserves the owner's feed token, so one bad call (an empty `--to` from a script) no longer makes the token unusable. A reservation an older CLI left for an empty DID holds no grant and is released the next time the token connects, so a token stuck with "already bound to another agent identity" needs no manual SQL.

Details: TC-3149
