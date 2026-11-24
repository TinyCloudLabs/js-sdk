---
"@tinycloud/cli": patch
---

`tc courier init --wait` collects the saved approval request with the lifetime, renewal and hosts it was made with. A different host setting on `--wait` is refused, also once the owner has approved the request. A different `--expiry` or `--renew` is refused while the request waits for approval.

Details: TC-4264
