---
"@tinycloud/web-sdk": patch
---

The permission prompt for `tinycloud.delegation/list` shows OpenKey's label and sentence for reading the delegation list, and the "Delegation" service name for other delegation actions. When the panel's permission request throws, the error's name and code are written to the console and the SDK debug log; the panel text is unchanged.

Details: TC-2113
