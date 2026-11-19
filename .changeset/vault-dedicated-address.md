---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

Vault and secrets requests to the production node now go to its dedicated address, including listings of the whole key space. So do grants that name or cover vault data, and sessions that name vault entries. Self-hosted nodes are unchanged.

Details: TC-2944
