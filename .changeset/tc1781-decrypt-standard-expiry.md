---
"@tinycloud/node-sdk": patch
---

Runtime permission grants that include decrypt follow the same expiry rules as other grants. `secrets.get` still asks only for the permission entries that are not already covered.

Details: TC-1781
