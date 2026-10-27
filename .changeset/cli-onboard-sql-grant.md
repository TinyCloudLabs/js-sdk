---
"@tinycloud/cli": patch
---

`tinycloud onboard` now also grants SQL read and write of apps' database rows on the applications space, under the same approval as files, so apps such as Health Log can read and write rows without a second approval.

Details: TC-2178
