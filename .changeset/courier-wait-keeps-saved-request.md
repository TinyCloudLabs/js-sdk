---
"@tinycloud/courier": patch
---

`courier init --wait` collects the saved approval request with the lifetime, renewal and hosts it was made with, so an approval the owner gave is kept. A different `--host`, `--openkey-host`, `--openkey-api-host`, `COURIER_OPENKEY_API_HOST` or `TC_LINKS_API_ORIGIN` is refused, also once the owner has approved the request. A different `--expiry` or `--renew` is refused while the request waits for approval; to ask for other terms, use `init --request`.

Details: TC-4264
