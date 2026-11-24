---
"@tinycloud/cli": patch
---

`tc courier init --wait` collects the saved approval request with the lifetime and renewal it was made with. A different `--expiry` or `--renew` on `--wait` is refused.

Details: TC-4264
