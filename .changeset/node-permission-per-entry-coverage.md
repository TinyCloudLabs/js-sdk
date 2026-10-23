---
"@tinycloud/node-sdk": patch
---

`secrets.get` now escalates only the permission entries that are not already covered. A read whose entries are all covered completes without a signer or a new grant. Escalations made by `secrets.get` expire after 59 minutes. Details: TC-1781
