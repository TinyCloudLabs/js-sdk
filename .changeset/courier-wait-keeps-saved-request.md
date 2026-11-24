---
"@tinycloud/courier": patch
---

`courier init --wait` collects the saved approval request with the lifetime and renewal it was made with, so an approval the owner gave is kept. An `--expiry` or `--renew` given to `--wait` that differs from the saved request is refused and nothing is replaced; to ask for other terms, use `init --request`.

Details: TC-4264
