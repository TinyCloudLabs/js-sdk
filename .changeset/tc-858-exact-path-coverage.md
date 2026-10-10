---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
---

Align replication eligibility, signed-session coverage, and local serving with sdk-core capability containment. Exact paths no longer authorize descendant prefixes or keys; only trailing-slash grants cover descendants.
