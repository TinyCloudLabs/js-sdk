---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Fix root sharing delegations to infer the delegated service from action URNs instead of always minting KV resources. Long-lived SQL share links now sign `tinycloud.sql/*` capabilities under the SQL service path.
