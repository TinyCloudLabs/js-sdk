---
"@tinycloud/cli": patch
---

`tc share publish --to email:<address> --notify` now emails the invitation and exits 0 instead of exiting 9 after the node refused delivery with `403 delivery-authorization-invalid`. Exact-email shares now sign the canonical recipient as their delivery address, which the node requires before it authorizes an invitation; `tc share notify` works for these shares too. Email shares published by earlier CLI versions carry no delivery address and still cannot be notified; publish them again.
