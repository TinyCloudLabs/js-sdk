---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

`courier watch` and `tc courier watch` now use a verified extension of the owner's grant without restarting. Running watchers can renew existing peer access before the original grants expire, without changing what either peer can read.

Automatic renewal shortens its cooldown when the owner grant limits a peer grant to a short lifetime. Manual renewal and artifact export retain their existing cooldown.

Details: TC-3522
