---
"@tinycloud/cli": patch
---

Report delegated SQL caveat refusals as one fixed line each: a refusal from the node (table, column, changes, or a grant that cannot be checked) exits as a permission denial, and a grant that needs table or column limits on a node that cannot enforce them is refused before anything is sent (usage error). Scope comparison treats table and column names that differ only in ASCII letter case as the same.

Details: TC-1839
