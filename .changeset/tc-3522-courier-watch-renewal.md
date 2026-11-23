---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

`courier watch` and `tc courier watch` now use a verified extension of the owner's grant without restarting. Running watchers can renew existing peer access before the original grants expire, without changing what either peer can read.

Details: TC-3522
