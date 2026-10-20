---
"@tinycloud/courier": patch
---

Bind merge approval requests to a head commit and case-sensitive base branch (TC-712). Merge requests now require `--head-sha` and `--base`; older unpinned merge requests must be re-requested and approved again. Other verbs reject these fields. Approval verification returns both pins and can require exact matches for the broker.
