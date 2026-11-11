---
"@tinycloud/courier": patch
---

`courier revoke` now revokes the peer's access on your TinyCloud node, so their next read is refused. If it can't finish, the pairing is kept and you can run it again. Details: TC-712
