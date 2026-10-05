---
"@tinycloud/cli": patch
---

`tc delegation revoke <cid>` now acquires `tinycloud.delegation/revoke` when the active session does not already have it. The ability is requested only for the explicit revoke operation; default owner login permissions remain unchanged.
