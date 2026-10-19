---
"@tinycloud/cli": patch
---

A plain OpenKey `auth login` on a profile that already belongs to an owner now names that owner's space, so OpenKey preselects the owner's key without `--owner`. The signed owner is still verified after approval.
