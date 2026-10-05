---
"@tinycloud/node-sdk": patch
---

Runtime `tinycloud.delegation/revoke` grants now supply their activated proof when signing CID-targeted revocation control invocations. Other CID-targeted delegation actions do not use this grant.
