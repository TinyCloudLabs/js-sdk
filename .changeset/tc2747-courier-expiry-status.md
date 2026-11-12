---
"@tinycloud/courier": patch
---

Add `courier status [--peer <peer>] [--json]` to show saved inbound and outbound grant expiry separately, with warnings within 24 hours of expiry. Status does not contact a peer or check automatic renewal.

Details: TC-2747, TC-2755
